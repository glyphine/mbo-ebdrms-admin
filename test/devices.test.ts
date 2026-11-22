import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, TransactionRollbackError } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { activityLogsTable, authSessionsTable, refreshTokensTable, userDevicesTable, usersTable } from '../src/db/schema.js';
import { approveDevice, requestDeviceEnrollment, revokeDevice, verifyApprovedDevice } from '../src/devices/service.js';

const databaseUrl = process.env['DEVICE_TEST_DATABASE_URL'];
const skip = !databaseUrl && 'Set DEVICE_TEST_DATABASE_URL to a disposable migrated PostgreSQL database';

const futureExpiry = () => new Date(Date.now() + 60_000);
const testUser = (fullName: string) => ({
  id: randomUUID(), email: `${randomUUID()}@example.test`, fullName, passwordHash: 'test-fixture-only',
});
const tokenHash = () => createHash('sha256').update(randomBytes(32)).digest('hex');

function violates(constraint: string) {
  return (error: unknown) => error instanceof Error &&
    (error.cause as { constraint?: string } | undefined)?.constraint === constraint;
}

test('device enrollment, approval, proof and revocation are scoped to the owner and audited', { skip }, async (t) => {
  assert.ok(databaseUrl);
  const { db, close } = createDatabase(databaseUrl);
  t.after(close);

  await assert.rejects(db.transaction(async (tx) => {
    const owner = testUser('Owner');
    const other = testUser('Other user');
    const operator = testUser('Operator');
    const disabled = { ...testUser('Disabled user'), isActive: false };
    await tx.insert(usersTable).values([owner, other, operator, disabled]);
    await assert.rejects(requestDeviceEnrollment(tx, disabled.id, 'Phone'), /enrollment unavailable/);
    await assert.rejects(requestDeviceEnrollment(tx, owner.id, '   '), /Device label/);

    const enrolled = await requestDeviceEnrollment(tx, owner.id, '  Budget phone  ');
    const target = { userId: owner.id, deviceId: enrolled.deviceId };
    const wrongOwner = { ...target, userId: other.id };
    const [pending] = await tx.select().from(userDevicesTable).where(eq(userDevicesTable.id, target.deviceId));
    assert.ok(pending);
    assert.equal(enrolled.status, 'pending');
    assert.equal(pending.label, 'Budget phone');
    assert.match(enrolled.credential, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(pending.credentialHash, createHash('sha256').update(enrolled.credential).digest('hex'));
    assert.deepEqual(await tx.select().from(authSessionsTable).where(eq(authSessionsTable.deviceId, target.deviceId)), []);
    assert.equal(await verifyApprovedDevice(tx, target, enrolled.credential), false);
    assert.equal(await approveDevice(tx, operator.id, wrongOwner), false);
    assert.equal(await revokeDevice(tx, operator.id, wrongOwner), false);

    assert.equal(await approveDevice(tx, operator.id, target), true);
    assert.equal(await approveDevice(tx, operator.id, target), false);
    assert.equal(await verifyApprovedDevice(tx, target, enrolled.credential), true);
    assert.equal(await verifyApprovedDevice(tx, target, randomBytes(32).toString('base64url')), false);
    assert.equal(await verifyApprovedDevice(tx, wrongOwner, enrolled.credential), false);

    const sibling = await requestDeviceEnrollment(tx, owner.id, 'Other phone');
    const siblingTarget = { userId: owner.id, deviceId: sibling.deviceId };
    assert.equal(await approveDevice(tx, operator.id, siblingTarget), true);
    const sessions = [target, siblingTarget].map((device) => ({ ...device, id: randomUUID(), expiresAt: futureExpiry() }));
    await tx.insert(authSessionsTable).values(sessions);

    assert.equal(await revokeDevice(tx, operator.id, target), true);
    assert.equal(await revokeDevice(tx, operator.id, target), false);
    assert.equal(await approveDevice(tx, operator.id, target), false);
    assert.equal(await verifyApprovedDevice(tx, target, enrolled.credential), false);
    const [revokedDevice] = await tx.select().from(userDevicesTable).where(eq(userDevicesTable.id, target.deviceId));
    assert.equal(revokedDevice?.status, 'revoked');
    assert.ok(revokedDevice.approvedAt instanceof Date);
    assert.ok(revokedDevice.revokedAt instanceof Date);
    const savedSessions = await tx.select().from(authSessionsTable).where(eq(authSessionsTable.userId, owner.id));
    assert.ok(savedSessions.find((session) => session.deviceId === target.deviceId)?.revokedAt instanceof Date);
    assert.equal(savedSessions.find((session) => session.deviceId === siblingTarget.deviceId)?.revokedAt, null);

    const cancelled = await requestDeviceEnrollment(tx, owner.id, 'Cancelled phone');
    const cancelledTarget = { userId: owner.id, deviceId: cancelled.deviceId };
    assert.notEqual(cancelled.credential, enrolled.credential);
    assert.equal(await revokeDevice(tx, operator.id, cancelledTarget), true);
    assert.equal(await approveDevice(tx, operator.id, cancelledTarget), false);
    await tx.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, owner.id));
    assert.equal(await verifyApprovedDevice(tx, siblingTarget, sibling.credential), false);

    const audit = await tx.select().from(activityLogsTable).where(eq(activityLogsTable.entityId, target.deviceId));
    assert.deepEqual(audit.map((event) => [event.action, event.actorUserId]).sort(), [
      ['device.approved', operator.id], ['device.enrollment_requested', owner.id], ['device.revoked', operator.id],
    ]);
    assert.ok(audit.every((event) => event.metadata?.['targetUserId'] === owner.id));
    assert.ok(!JSON.stringify(audit).includes(enrolled.credential));
    tx.rollback();
  }), TransactionRollbackError);
});

test('database constraints enforce session ownership and refresh-token lineage', { skip }, async (t) => {
  assert.ok(databaseUrl);
  const { db, close } = createDatabase(databaseUrl);
  t.after(close);

  await assert.rejects(db.transaction(async (tx) => {
    const user = testUser('Owner');
    const other = testUser('Other user');
    await tx.insert(usersTable).values([user, other]);
    const { deviceId } = await requestDeviceEnrollment(tx, user.id, 'Phone');
    await approveDevice(tx, user.id, { userId: user.id, deviceId });

    const session = { id: randomUUID(), userId: user.id, deviceId, expiresAt: futureExpiry() };
    const secondSession = { ...session, id: randomUUID() };
    await tx.insert(authSessionsTable).values([session, secondSession]);
    await assert.rejects(tx.transaction(async (savepoint) => {
      await savepoint.insert(authSessionsTable).values({ ...session, id: randomUUID(), userId: other.id });
    }), violates('auth_sessions_device_owner_fk'));

    const root = { id: randomUUID(), sessionId: session.id, tokenHash: tokenHash(), expiresAt: futureExpiry() };
    await tx.insert(refreshTokensTable).values(root);
    const replacement = { ...root, id: randomUUID(), previousTokenId: root.id, tokenHash: tokenHash() };
    await assert.rejects(tx.transaction(async (savepoint) => {
      await savepoint.insert(refreshTokensTable).values(replacement);
    }), violates('refresh_tokens_session_unconsumed_uq'));
    await assert.rejects(tx.transaction(async (savepoint) => {
      await savepoint.insert(refreshTokensTable).values({ ...replacement, sessionId: secondSession.id });
    }), violates('refresh_tokens_previous_session_fk'));

    await tx.update(refreshTokensTable).set({ consumedAt: new Date() }).where(eq(refreshTokensTable.id, root.id));
    await assert.rejects(tx.transaction(async (savepoint) => {
      await savepoint.insert(refreshTokensTable).values({ ...root, id: randomUUID(), tokenHash: tokenHash() });
    }), violates('refresh_tokens_session_root_uq'));
    await tx.insert(refreshTokensTable).values(replacement);
    const family = await tx.select().from(refreshTokensTable).where(eq(refreshTokensTable.sessionId, session.id));
    assert.equal(family.length, 2);
    assert.ok(family.find((token) => token.id === root.id)?.consumedAt instanceof Date);
    assert.equal(family.find((token) => token.id === replacement.id)?.previousTokenId, root.id);
    tx.rollback();
  }), TransactionRollbackError);
});
