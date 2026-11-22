import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { activityLogsTable, authLogsTable, authSessionsTable, refreshTokensTable, userDevicesTable, usersTable } from '../src/db/schema.js';
import { approveDevice, requestDeviceEnrollment, revokeDevice } from '../src/devices/service.js';

const base = '/api/v1/auth';
const testDatabase = process.env['DEVICE_TEST_DATABASE_URL'];
const currentKey = Buffer.alloc(32, 1);
const previousKey = Buffer.alloc(32, 2);
const configFor = (databaseUrl: string) => loadConfig({
  NODE_ENV: 'test', DATABASE_URL: databaseUrl, AUTH_JWT_ACTIVE_KID: 'current',
  AUTH_JWT_KEYS: JSON.stringify({ current: currentKey.toString('base64url'), previous: previousKey.toString('base64url') }),
});

test('password verifier handles exact passwords, wrong credentials and unknown hash formats', async () => {
  const password = ' a passphrase with spaces ';
  const hash = await hashPassword(password);
  assert.match(hash, /^scrypt-v1:[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.notEqual(await hashPassword(password), hash);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword(password.trim(), hash), false);
  assert.equal(await verifyPassword(password, undefined), false);
  assert.equal(await verifyPassword(password, `${hash}:unsupported`), false);
});

test('auth throttles requests per client before processing invalid enrollment bodies', async (t) => {
  const app = createApp(configFor('postgresql://test@localhost/test'));
  t.after(() => app.close());
  for (let index = 0; index < 5; index++) {
    assert.equal((await app.inject({ method: 'POST', url: `${base}/enroll`, payload: {} })).statusCode, 400);
  }
  const limited = await app.inject({ method: 'POST', url: `${base}/enroll`, payload: {} });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, 'REQUEST_ERROR');
  assert.ok(limited.headers['retry-after']);
  assert.equal((await app.inject('/health/live')).statusCode, 200);
});

test('device-gated HTTP authentication and token lifecycle', {
  skip: !testDatabase && 'Set DEVICE_TEST_DATABASE_URL to a disposable migrated PostgreSQL database',
}, async (t) => {
  assert.ok(testDatabase);
  const database = createDatabase(testDatabase);
  const { db } = database;
  const config = configFor(testDatabase);
  let logs = '';
  const logStream = new Writable({
    write(chunk, _encoding, callback) { logs += chunk.toString(); callback(); },
  });
  const app = createApp(config, { database, logStream });
  const userId = randomUUID();
  const otherId = randomUUID();
  const fixtureIds = [userId, otherId];
  t.after(async () => {
    try {
      await db.transaction(async (tx) => {
        const sessions = tx.select({ id: authSessionsTable.id }).from(authSessionsTable)
          .where(inArray(authSessionsTable.userId, fixtureIds));
        await tx.delete(refreshTokensTable).where(inArray(refreshTokensTable.sessionId, sessions));
        await tx.delete(authSessionsTable).where(inArray(authSessionsTable.userId, fixtureIds));
        await tx.delete(userDevicesTable).where(inArray(userDevicesTable.userId, fixtureIds));
        await tx.delete(activityLogsTable).where(inArray(activityLogsTable.actorUserId, fixtureIds));
        await tx.delete(authLogsTable).where(inArray(authLogsTable.userId, fixtureIds));
        await tx.delete(usersTable).where(inArray(usersTable.id, fixtureIds));
      });
    } finally {
      await app.close();
    }
  });
  const credentials = { email: `${userId}@example.test`, password: 'fixture-password-with-spaces ' };
  const otherEmail = `${otherId}@example.test`;
  const passwordHash = await hashPassword(credentials.password);
  await db.insert(usersTable).values([
    { id: userId, email: credentials.email, fullName: 'Auth fixture', passwordHash },
    { id: otherId, email: otherEmail, fullName: 'Other fixture', passwordHash },
  ]);

  const post = (path: string, payload: object, remoteAddress = '192.0.2.1') =>
    app.inject({ method: 'POST', url: `${base}/${path}`, payload, remoteAddress });
  const bearer = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });
  const me = (accessToken: string) => app.inject({ url: `${base}/me`, headers: bearer(accessToken) });
  const denied = (response: { statusCode: number; json(): { error: { code: string } } }) => {
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'AUTHENTICATION_FAILED');
  };

  const failed = await post('enroll', { ...credentials, password: 'incorrect', label: 'Phone' });
  denied(failed);
  assert.deepEqual(await db.select().from(userDevicesTable).where(eq(userDevicesTable.userId, userId)), []);
  const enrolled = await post('enroll', { ...credentials, label: 'Phone' });
  assert.equal(enrolled.statusCode, 201);
  assert.equal(enrolled.headers['cache-control'], 'no-store');
  const { deviceId, deviceCredential, status } = enrolled.json<{ deviceId: string; deviceCredential: string; status: string }>();
  const proof = { deviceId, deviceCredential };
  assert.equal(status, 'pending');
  const loginInput = { ...credentials, ...proof };
  const otherDevice = await requestDeviceEnrollment(db, otherId, 'Other phone');
  assert.ok(await approveDevice(db, otherId, { userId: otherId, deviceId: otherDevice.deviceId }));

  const pendingLogin = await post('login', loginInput);
  denied(pendingLogin);
  assert.equal(pendingLogin.json().error.message, failed.json().error.message);
  assert.deepEqual(await db.select().from(authSessionsTable).where(eq(authSessionsTable.userId, userId)), []);
  assert.ok(await approveDevice(db, userId, { userId, deviceId }));
  denied(await post('login', { ...loginInput, deviceCredential: randomBytes(32).toString('base64url') }));
  denied(await post('login', { ...loginInput, email: otherEmail }));

  async function login(remoteAddress = '192.0.2.1') {
    const response = await post('login', loginInput, remoteAddress);
    assert.equal(response.statusCode, 200, `Login returned ${response.statusCode}`);
    assert.equal(response.headers['cache-control'], 'no-store');
    const tokens = response.json<{ accessToken: string; refreshToken: string; expiresIn: number; tokenType: string }>();
    assert.equal(tokens.expiresIn, 600);
    assert.equal(tokens.tokenType, 'Bearer');
    return tokens;
  }

  await t.test('access tokens validate claims and support signing-key rotation', async () => {
    const tokens = await login();
    const response = await me(tokens.accessToken);
    assert.equal(response.statusCode, 200);
    const identity = response.json<{ userId: string; sessionId: string; deviceId: string }>();
    assert.deepEqual(identity, { userId, sessionId: identity.sessionId, deviceId });
    const now = Math.floor(Date.now() / 1000);
    const payload = { sub: userId, sid: identity.sessionId, did: deviceId, jti: randomUUID() };
    const signedWithPreviousKey = app.jwt.sign(payload, { key: previousKey, kid: 'previous' });
    assert.equal((await me(signedWithPreviousKey)).statusCode, 200);
    for (const invalidToken of [
      app.jwt.sign(payload, { key: currentKey, kid: 'unknown' }),
      app.jwt.sign(payload, { key: currentKey, iss: 'wrong-issuer' }),
      app.jwt.sign(payload, { key: currentKey, aud: 'wrong-audience' }),
      app.jwt.sign(payload, { key: currentKey, header: { alg: 'HS256', typ: 'JWT' } }),
      app.jwt.sign({ ...payload, iat: now - 601 }, { key: currentKey }),
      app.jwt.sign({ sub: userId, sid: identity.sessionId, did: deviceId }, { key: currentKey }),
      app.jwt.sign({ ...payload, did: otherDevice.deviceId }, { key: currentKey }),
      tokens.refreshToken,
    ]) denied(await me(invalidToken));

    const [saved] = await db.select().from(refreshTokensTable).where(eq(refreshTokensTable.sessionId, identity.sessionId));
    assert.equal(saved?.tokenHash, createHash('sha256').update(tokens.refreshToken).digest('hex'));
  });

  await t.test('refresh proves device possession and rejects expired tokens', async () => {
    const tokens = await login();
    const { sessionId } = (await me(tokens.accessToken)).json<{ sessionId: string }>();
    const original = { ...proof, refreshToken: tokens.refreshToken };
    denied(await post('refresh', { ...original, deviceCredential: randomBytes(32).toString('base64url') }));
    denied(await post('refresh', { ...original, deviceId: otherDevice.deviceId, deviceCredential: otherDevice.credential }));
    assert.equal((await me(tokens.accessToken)).statusCode, 200);
    const rotated = await post('refresh', original);
    assert.equal(rotated.statusCode, 200);
    const next = rotated.json<{ accessToken: string; refreshToken: string }>();
    assert.notEqual(next.refreshToken, original.refreshToken);
    denied(await post('refresh', { ...original, deviceCredential: randomBytes(32).toString('base64url') }));
    assert.equal((await me(next.accessToken)).statusCode, 200);

    await db.update(refreshTokensTable).set({
      createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000),
    }).where(eq(refreshTokensTable.tokenHash, createHash('sha256').update(next.refreshToken).digest('hex')));
    denied(await post('refresh', { ...proof, refreshToken: next.refreshToken }));
    assert.equal((await me(next.accessToken)).statusCode, 200);
    await db.update(authSessionsTable).set({
      createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000),
    }).where(eq(authSessionsTable.id, sessionId));
    denied(await me(next.accessToken));
  });

  await t.test('concurrent refreshes allow one rotation and revoke the family on reuse', async () => {
    const tokens = await login();
    const { sessionId } = (await me(tokens.accessToken)).json<{ sessionId: string }>();
    const duplicate = { ...proof, refreshToken: tokens.refreshToken };
    const rotations = await Promise.all([post('refresh', duplicate), post('refresh', duplicate)]);
    assert.deepEqual(rotations.map(({ statusCode }) => statusCode).sort(), [200, 401]);
    const successor = rotations.find(({ statusCode }) => statusCode === 200)?.json<{ accessToken: string; refreshToken: string }>();
    assert.ok(successor);
    denied(await me(tokens.accessToken));
    denied(await me(successor.accessToken));
    denied(await post('refresh', { ...proof, refreshToken: successor.refreshToken }));
    const rows = await db.select().from(refreshTokensTable).where(eq(refreshTokensTable.sessionId, sessionId));
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.previousTokenId === null)?.id, rows.find((row) => row.previousTokenId)?.previousTokenId);
    assert.equal(rows.filter((row) => row.consumedAt !== null).length, 1);
    assert.ok((await db.select().from(authLogsTable).where(eq(authLogsTable.userId, userId)))
      .some((event) => event.action === 'auth.refresh_reuse'));
  });

  await t.test('logout and per-device invalidation take effect immediately', async () => {
    const tokens = await login('192.0.2.2');
    const sibling = await login('192.0.2.2');
    const logout = await app.inject({ method: 'POST', url: `${base}/logout`, headers: bearer(tokens.accessToken) });
    assert.equal(logout.statusCode, 204);
    denied(await me(tokens.accessToken));
    denied(await post('refresh', { ...proof, refreshToken: tokens.refreshToken }));
    assert.equal((await me(sibling.accessToken)).statusCode, 200);

    const revokeSessions = (targetId: string) => app.inject({
      method: 'DELETE', url: `${base}/devices/${targetId}/sessions`, headers: bearer(sibling.accessToken),
    });
    assert.equal((await revokeSessions(otherDevice.deviceId)).statusCode, 404);
    assert.equal((await revokeSessions(deviceId)).statusCode, 204);
    denied(await me(sibling.accessToken));
    denied(await post('refresh', { ...proof, refreshToken: sibling.refreshToken }));

    const afterRevocation = await login('192.0.2.2');
    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, userId));
    denied(await me(afterRevocation.accessToken));
    denied(await post('refresh', { ...proof, refreshToken: afterRevocation.refreshToken }));
    await db.update(usersTable).set({ isActive: true }).where(eq(usersTable.id, userId));
    assert.ok(await revokeDevice(db, userId, { userId, deviceId }));
    denied(await me(afterRevocation.accessToken));
    denied(await post('refresh', { ...proof, refreshToken: afterRevocation.refreshToken }));
    denied(await post('login', loginInput, '192.0.2.2'));

    for (const secret of [credentials.password, deviceCredential, tokens.accessToken, tokens.refreshToken]) {
      assert.equal(logs.includes(secret), false);
    }
  });
});
