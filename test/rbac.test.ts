import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { authenticate } from '../src/auth/access.js';
import { hashPassword } from '../src/auth/password.js';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { activityLogsTable, authLogsTable, authSessionsTable, documentsTable, documentTemplatesTable, documentTypesTable,
  officesTable, permissionsTable, refreshTokensTable, roleDocumentTypePermissionsTable, rolePermissionsTable, rolesTable, userDevicesTable,
  userRolesTable, usersTable } from '../src/db/schema.js';
import { approveDevice, requestDeviceEnrollment } from '../src/devices/service.js';
import { adminPermissions, authorizeDocument, authorizeDocumentType, documentPermissions, forbidden, hasGrant } from '../src/rbac/permissions.js';

const databaseUrl = process.env['DEVICE_TEST_DATABASE_URL'];
const signingKey = Buffer.alloc(32, 13);

test('permission matching requires the exact action and scope', () => {
  const grants = [
    { name: 'documents.read', documentTypeId: 'type-a' },
    { name: 'documents.export', documentTypeId: null },
    { name: 'devices.manage', documentTypeId: 'type-a' },
  ];
  assert.equal(hasGrant(grants, 'documents.read', 'type-a'), true);
  assert.equal(hasGrant(grants, 'documents.read', 'type-b'), false);
  assert.equal(hasGrant(grants, 'documents.read'), false);
  assert.equal(hasGrant(grants, 'documents.export', 'type-b'), true);
  assert.equal(hasGrant(grants, 'documents.revise', 'type-a'), false);
  assert.equal(hasGrant(grants, 'devices.manage', 'type-a'), false);
  assert.equal(hasGrant([], 'documents.read', 'type-a'), false);
});

test('admin routes and document guards apply live grants and session state', {
  skip: !databaseUrl && 'Set DEVICE_TEST_DATABASE_URL to a disposable migrated PostgreSQL database',
}, async (t) => {
  assert.ok(databaseUrl);
  const database = createDatabase(databaseUrl);
  const { db } = database;
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, AUTH_JWT_ACTIVE_KID: 'test',
    AUTH_JWT_KEYS: JSON.stringify({ test: signingKey.toString('base64url') }) });
  const app = createApp(config, { database });
  app.get<{ Params: { id: string } }>('/test/guarded-documents/:id', { preHandler: authenticate }, async (request, reply) => {
    const document = await authorizeDocument(db, request.auth!.userId, request.params.id, 'documents.read');
    return document ?? forbidden(reply);
  });
  const [adminId, editorId] = [randomUUID(), randomUUID()];
  const credentials = { email: `${editorId}@example.test`, password: 'fixture-password' };
  const passwordHash = await hashPassword(credentials.password);
  const [adminRole, editorRole] = [randomUUID(), randomUUID()];
  const [typeA, typeB] = [randomUUID(), randomUUID()];
  const [officeA, officeB] = [randomUUID(), randomUUID()];
  const [templateA, templateB] = [randomUUID(), randomUUID()];
  const [draftA, finalizedA, voidedA, draftB] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const userIds = [adminId, editorId];
  const roleIds = [adminRole, editorRole];
  const permissionNames = [...adminPermissions, ...documentPermissions];
  const fixturePermissionIds: string[] = [];

  t.after(async () => {
    try {
      await db.transaction(async (tx) => {
        const sessions = tx.select({ id: authSessionsTable.id }).from(authSessionsTable).where(inArray(authSessionsTable.userId, userIds));
        await tx.delete(refreshTokensTable).where(inArray(refreshTokensTable.sessionId, sessions));
        await tx.delete(authLogsTable).where(inArray(authLogsTable.userId, userIds));
        await tx.delete(activityLogsTable).where(inArray(activityLogsTable.actorUserId, userIds));
        await tx.delete(authSessionsTable).where(inArray(authSessionsTable.userId, userIds));
        await tx.delete(userDevicesTable).where(inArray(userDevicesTable.userId, userIds));
        await tx.delete(documentsTable).where(inArray(documentsTable.id, [draftA, finalizedA, voidedA, draftB]));
        await tx.delete(documentTemplatesTable).where(inArray(documentTemplatesTable.id, [templateA, templateB]));
        await tx.delete(documentTypesTable).where(inArray(documentTypesTable.id, [typeA, typeB]));
        await tx.delete(rolesTable).where(inArray(rolesTable.id, roleIds));
        await tx.delete(usersTable).where(inArray(usersTable.id, userIds));
        await tx.delete(officesTable).where(inArray(officesTable.id, [officeA, officeB]));
        await tx.delete(permissionsTable).where(inArray(permissionsTable.id, fixturePermissionIds));
      });
    } finally {
      await app.close();
    }
  });

  await db.transaction(async (tx) => {
    await tx.insert(officesTable).values([officeA, officeB].map((id) => ({ id, code: id.slice(0, 24), name: 'Test office' })));
    await tx.insert(usersTable).values(userIds.map((id) => ({ id, email: `${id}@example.test`, fullName: 'RBAC fixture',
      officeId: officeA, passwordHash })));
    await tx.insert(rolesTable).values(roleIds.map((id) => ({ id, name: `rbac-fixture-${id}` })));
    const created = await tx.insert(permissionsTable).values(permissionNames.map((name) => ({ name })))
      .onConflictDoNothing().returning({ id: permissionsTable.id });
    fixturePermissionIds.push(...created.map(({ id }) => id));
    const permissions = await tx.select().from(permissionsTable).where(inArray(permissionsTable.name, permissionNames));
    await tx.insert(userRolesTable).values({ userId: adminId, roleId: adminRole });
    await tx.insert(rolePermissionsTable).values(permissions.filter(({ name }) => name.endsWith('.manage') || name === 'documents.read')
      .map(({ id }) => ({ roleId: adminRole, permissionId: id })));
    await tx.insert(documentTypesTable).values([typeA, typeB].map((id) => ({ id, code: `test-${id}`, name: `Type ${id}` })));
    await tx.insert(roleDocumentTypePermissionsTable).values(permissions.filter(({ name }) =>
      name.startsWith('documents.') && name !== 'documents.read')
      .map(({ id }) => ({ roleId: adminRole, permissionId: id, documentTypeId: typeA })));
    await tx.insert(documentTemplatesTable).values([
      { id: templateA, documentTypeId: typeA, name: 'Template A', resourceKey: templateA },
      { id: templateB, documentTypeId: typeB, name: 'Template B', resourceKey: templateB },
    ]);
    await tx.insert(documentsTable).values([
      { id: draftA, templateId: templateA, createdBy: adminId, managingOfficeId: officeB, title: 'Draft A' },
      { id: finalizedA, templateId: templateA, createdBy: adminId, title: 'Finalized A', status: 'finalized' },
      { id: voidedA, templateId: templateA, createdBy: adminId, title: 'Voided A', status: 'voided' },
      { id: draftB, templateId: templateB, createdBy: editorId, managingOfficeId: officeA, title: 'Draft B' },
    ]);
  });
  await app.ready();

  async function makeSession(userId: string, deviceId: string) {
    const sessionId = randomUUID();
    await db.insert(authSessionsTable).values({ id: sessionId, userId, deviceId, expiresAt: sql`now() + interval '1 hour'` });
    return app.jwt.sign({ sub: userId, sid: sessionId, did: deviceId, jti: randomUUID() }, { key: signingKey });
  }
  const admin = await requestDeviceEnrollment(db, adminId, 'Admin installation');
  const editor = await requestDeviceEnrollment(db, editorId, 'Editor installation');
  for (const { userId, deviceId } of [{ userId: adminId, ...admin }, { userId: editorId, ...editor }]) {
    assert.equal(await approveDevice(db, adminId, { userId, deviceId }), true);
  }
  const authPost = (route: string, payload: object) => app.inject({ method: 'POST', url: `/api/v1/auth/${route}`, payload });
  const enrolled = await authPost('enroll', { ...credentials, label: 'Pending installation' });
  assert.equal(enrolled.statusCode, 201);
  const proof = enrolled.json<{ deviceId: string; deviceCredential: string; status: string }>();
  assert.equal(proof.status, 'pending');
  const pending = { deviceId: proof.deviceId, deviceCredential: proof.deviceCredential };
  const adminToken = await makeSession(adminId, admin.deviceId);
  const editorToken = await makeSession(editorId, editor.deviceId);
  const adminApi = '/api/v1/admin';
  function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', path: string, token?: string, payload?: object) {
    return app.inject({ method, url: `${adminApi}${path}`, ...(token && { headers: { authorization: `Bearer ${token}` } }),
      ...(payload && { payload }) });
  }
  const getDocument = (id: string) => app.inject({ url: `/test/guarded-documents/${id}`, headers: { authorization: `Bearer ${editorToken}` } });
  const membership = `/users/${editorId}/roles/${editorRole}`;
  const scopedGrant = (roleId: string, typeId: string, permission: string) => `/roles/${roleId}/document-types/${typeId}/permissions/${permission}`;

  await t.test('anonymous and ordinary sessions cannot administer devices, users or grants', async () => {
    assert.equal((await authPost('login', { ...credentials, ...pending })).statusCode, 401);
    assert.equal((await call('GET', '/roles')).statusCode, 401);
    assert.equal((await call('GET', '/devices/pending', editorToken)).statusCode, 403);
    assert.equal((await call('POST', `/devices/${pending.deviceId}/approve`, editorToken)).statusCode, 403);
    assert.equal((await call('PATCH', `/users/${adminId}/status`, editorToken, { isActive: false })).statusCode, 403);
    assert.equal((await call('PUT', membership, editorToken)).statusCode, 403);
    assert.equal((await getDocument(draftA)).statusCode, 403);

    const users = await call('GET', '/users', adminToken);
    assert.equal(users.statusCode, 200);
    assert.ok(users.json().some(({ id }: { id: string }) => id === editorId));
    assert.doesNotMatch(users.body, /passwordHash|scrypt-v1/);
    const queue = await call('GET', '/devices/pending', adminToken);
    assert.equal(queue.statusCode, 200);
    assert.ok(queue.json().some(({ id }: { id: string }) => id === pending.deviceId));
    assert.doesNotMatch(queue.body, /credential|verifier/);
    assert.equal((await call('POST', `/devices/${pending.deviceId}/approve`, adminToken)).statusCode, 204);
    assert.equal((await call('POST', `/devices/${pending.deviceId}/approve`, adminToken)).statusCode, 204);
    assert.equal((await call('GET', '/roles', await makeSession(editorId, pending.deviceId))).statusCode, 403);
  });

  await t.test('delegation stays within the actor grant and documents use their stored type and lifecycle', async () => {
    assert.equal((await call('PUT', `/users/${editorId}/roles/${adminRole}`, adminToken)).statusCode, 403);
    assert.equal((await call('PUT', scopedGrant(adminRole, typeA, 'documents.read'), adminToken)).statusCode, 403);
    assert.equal((await call('PUT', scopedGrant(editorRole, typeA, 'devices.manage'), adminToken)).statusCode, 400);
    assert.equal((await call('PUT', scopedGrant(editorRole, typeB, 'documents.revise'), adminToken)).statusCode, 403);
    assert.equal((await call('PUT', `/roles/${editorRole}/permissions/documents.revise`, adminToken)).statusCode, 403);
    assert.equal((await call('PUT', scopedGrant(editorRole, typeA, 'documents.read'), adminToken)).statusCode, 204);
    assert.equal((await call('PUT', scopedGrant(editorRole, typeA, 'documents.revise'), adminToken)).statusCode, 204);
    assert.equal((await call('PUT', membership, adminToken)).statusCode, 204);
    assert.equal((await call('PUT', membership, adminToken)).statusCode, 204);

    assert.equal((await getDocument(draftA)).statusCode, 200); // Different managing office.
    assert.equal((await getDocument(draftB)).statusCode, 403); // Same office and creator, different type.
    assert.equal((await getDocument(voidedA)).statusCode, 200);
    assert.ok(await authorizeDocument(db, editorId, draftA, 'documents.revise'));
    assert.equal(await authorizeDocument(db, editorId, finalizedA, 'documents.revise'), undefined);
    assert.equal(await authorizeDocument(db, editorId, draftA, 'documents.finalize'), undefined);
    assert.ok(await authorizeDocument(db, adminId, finalizedA, 'documents.void'));
    assert.equal(await authorizeDocument(db, adminId, draftA, 'documents.void'), undefined);
    assert.equal(await authorizeDocument(db, adminId, voidedA, 'documents.export'), undefined);
    assert.equal(await authorizeDocumentType(db, adminId, typeA, 'documents.create'), true);
    await db.update(documentTypesTable).set({ isActive: false }).where(eq(documentTypesTable.id, typeA));
    assert.equal(await authorizeDocumentType(db, adminId, typeA, 'documents.create'), false);
    assert.equal((await getDocument(draftA)).statusCode, 200);

    const globalGrant = `/roles/${editorRole}/permissions/documents.read`;
    assert.equal((await call('PUT', globalGrant, adminToken)).statusCode, 204);
    assert.equal((await getDocument(draftB)).statusCode, 200);
    assert.equal((await call('DELETE', globalGrant, adminToken)).statusCode, 204);
    assert.equal((await getDocument(draftB)).statusCode, 403);
    assert.equal((await call('DELETE', membership, adminToken)).statusCode, 204);
    assert.equal((await getDocument(draftA)).statusCode, 403);
  });

  await t.test('revoked devices and disabled accounts lose their sessions, with audit events for actual changes', async () => {
    assert.equal((await call('POST', `/devices/${editor.deviceId}/revoke`, adminToken)).statusCode, 204);
    assert.equal((await call('GET', '/roles', editorToken)).statusCode, 401);
    assert.equal((await call('POST', `/devices/${editor.deviceId}/approve`, adminToken)).statusCode, 409);
    const activeToken = await makeSession(editorId, pending.deviceId);
    assert.equal((await call('GET', '/roles', activeToken)).statusCode, 403);
    assert.equal((await call('PATCH', `/users/${adminId}/status`, adminToken, { isActive: false })).statusCode, 403);
    assert.equal((await call('PATCH', `/users/${editorId}/status`, adminToken, { isActive: false })).statusCode, 204);
    assert.equal((await call('GET', '/roles', activeToken)).statusCode, 401);
    const lingeringToken = await makeSession(editorId, pending.deviceId);
    assert.equal((await call('PATCH', `/users/${editorId}/status`, adminToken, { isActive: true })).statusCode, 204);
    assert.equal((await call('GET', '/roles', activeToken)).statusCode, 401);
    assert.equal((await call('GET', '/roles', lingeringToken)).statusCode, 401);

    const signedIn = await authPost('login', { ...credentials, ...pending });
    assert.equal(signedIn.statusCode, 200);
    const initial = signedIn.json<{ refreshToken: string }>();
    const rotation = await authPost('refresh', { ...pending, refreshToken: initial.refreshToken });
    assert.equal(rotation.statusCode, 200);
    const rotated = rotation.json<{ accessToken: string; refreshToken: string }>();
    assert.notEqual(rotated.refreshToken, initial.refreshToken);
    const me = () => app.inject({ url: '/api/v1/auth/me', headers: { authorization: `Bearer ${rotated.accessToken}` } });
    const session = await me();
    assert.equal(session.statusCode, 200);
    assert.equal(session.json().deviceId, pending.deviceId);
    assert.equal((await call('POST', `/devices/${pending.deviceId}/revoke`, adminToken)).statusCode, 204);
    assert.equal((await me()).statusCode, 401);
    assert.equal((await authPost('refresh', { ...pending, refreshToken: rotated.refreshToken })).statusCode, 401);

    const audit = await db.select().from(activityLogsTable).where(eq(activityLogsTable.actorUserId, adminId));
    assert.equal(audit.filter(({ entityId, action }) => entityId === pending.deviceId && action === 'device.approved').length, 1);
    assert.equal(audit.filter(({ entityId, action }) => entityId === pending.deviceId && action === 'device.revoked').length, 1);
    assert.equal(audit.filter(({ action }) => action === 'rbac.role_assigned').length, 1);
    assert.ok(audit.some(({ action, metadata }) => action === 'rbac.role_removed' && metadata?.['roleId'] === editorRole));
    assert.ok(audit.some(({ action, metadata }) => action === 'rbac.permission_granted' && metadata?.['documentTypeId'] === typeA));
    assert.ok(audit.some(({ action, metadata }) => action === 'rbac.permission_removed' && metadata?.['documentTypeId'] === null));
    assert.ok(audit.some(({ action }) => action === 'user.disabled'));

    await db.delete(userRolesTable).where(and(eq(userRolesTable.userId, adminId), eq(userRolesTable.roleId, adminRole)));
    assert.equal((await call('GET', '/roles', adminToken)).statusCode, 403);
    assert.equal((await call('POST', `/devices/${pending.deviceId}/revoke`, adminToken)).statusCode, 403);
  });
});
