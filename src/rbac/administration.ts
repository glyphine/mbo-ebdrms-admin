import { and, eq, isNull, sql } from 'drizzle-orm';
import { activeSession } from '../auth/service.js';
import type { SessionIdentity } from '../auth/service.js';
import type { Database } from '../db/client.js';
import { activityLogsTable, authSessionsTable, documentTypesTable, permissionsTable, roleDocumentTypePermissionsTable,
  rolePermissionsTable, rolesTable, userDevicesTable, userRolesTable, usersTable } from '../db/schema.js';
import { approveDevice, revokeDevice } from '../devices/service.js';
import { adminPermissions, hasGrant, roleGrants, userGrants } from './permissions.js';
import type { AdminPermission, DocumentPermission, Grant } from './permissions.js';

type Transaction = Parameters<Parameters<Database['db']['transaction']>[0]>[0];
type MutationResult = 'ok' | 'forbidden' | 'not-found' | 'conflict';

export function administer(db: Database['db'], identity: SessionIdentity, permission: AdminPermission,
  mutation: (tx: Transaction, grants: readonly Grant[]) => Promise<MutationResult>) {
  return db.transaction(async (tx) => {
    // Administrative writes are infrequent. Serialize delegation and grant changes across API processes.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('ebdrms:access-administration', 0))`);
    if (!await activeSession(tx, identity)) return 'unauthenticated';
    const grants = await userGrants(tx, identity.userId);
    if (!hasGrant(grants, permission)) return 'forbidden';
    return mutation(tx, grants);
  });
}

function isAdministrative(grants: readonly Grant[]) {
  return adminPermissions.some((permission) => hasGrant(grants, permission));
}

export async function changeDeviceStatus(tx: Transaction, actorId: string, deviceId: string,
  operation: 'approve' | 'revoke'): Promise<MutationResult> {
  const [device] = await tx.select({ deviceId: userDevicesTable.id, userId: userDevicesTable.userId, status: userDevicesTable.status })
    .from(userDevicesTable).where(eq(userDevicesTable.id, deviceId));
  if (!device) return 'not-found';
  if (device.status === (operation === 'approve' ? 'approved' : 'revoked')) return 'ok';
  const changed = operation === 'approve' ? await approveDevice(tx, actorId, device) : await revokeDevice(tx, actorId, device);
  return changed ? 'ok' : 'conflict';
}

export async function setAccountActive(tx: Transaction, actorId: string, userId: string, active: boolean): Promise<MutationResult> {
  const [account] = await tx.select({ id: usersTable.id, active: usersTable.isActive }).from(usersTable)
    .where(eq(usersTable.id, userId)).for('update');
  if (!account) return 'not-found';
  if (account.id === actorId.toLowerCase() || isAdministrative(await userGrants(tx, account.id, true))) return 'forbidden';
  if (account.active === active) return 'ok';

  await tx.update(usersTable).set({ isActive: active }).where(eq(usersTable.id, account.id));
  await tx.update(authSessionsTable).set({ revokedAt: sql`clock_timestamp()` })
    .where(and(eq(authSessionsTable.userId, account.id), isNull(authSessionsTable.revokedAt)));
  await tx.insert(activityLogsTable).values({
    actorUserId: actorId, entityType: 'user', entityId: account.id, action: active ? 'user.enabled' : 'user.disabled',
  });
  return 'ok';
}

export async function changeRoleAssignment(tx: Transaction, actorId: string, actorGrants: readonly Grant[],
  target: { userId: string; roleId: string }, assign: boolean): Promise<MutationResult> {
  const [account] = await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, target.userId));
  const [role] = await tx.select({ id: rolesTable.id }).from(rolesTable).where(eq(rolesTable.id, target.roleId));
  if (!account || !role) return 'not-found';
  const grants = await roleGrants(tx, role.id);
  if (isAdministrative(grants) || grants.some((grant) => !hasGrant(actorGrants, grant.name, grant.documentTypeId))) {
    return 'forbidden';
  }

  const membership = { userId: account.id, roleId: role.id };
  const [changed] = assign
    ? await tx.insert(userRolesTable).values(membership).onConflictDoNothing().returning({ roleId: userRolesTable.roleId })
    : await tx.delete(userRolesTable).where(and(eq(userRolesTable.userId, account.id), eq(userRolesTable.roleId, role.id)))
      .returning({ roleId: userRolesTable.roleId });
  if (changed) {
    await tx.insert(activityLogsTable).values({
      actorUserId: actorId, entityType: 'user', entityId: account.id,
      action: assign ? 'rbac.role_assigned' : 'rbac.role_removed', metadata: { roleId: role.id },
    });
  }
  return 'ok';
}

export async function changeDocumentGrant(tx: Transaction, actorId: string, actorGrants: readonly Grant[],
  target: { roleId: string; permission: DocumentPermission; documentTypeId?: string }, grant: boolean): Promise<MutationResult> {
  const [role] = await tx.select({ id: rolesTable.id }).from(rolesTable).where(eq(rolesTable.id, target.roleId));
  const [permission] = await tx.select({ id: permissionsTable.id }).from(permissionsTable)
    .where(eq(permissionsTable.name, target.permission));
  const scope = target.documentTypeId?.toLowerCase() ?? null;
  if (!role || !permission) return 'not-found';
  if (isAdministrative(await roleGrants(tx, role.id)) || !hasGrant(actorGrants, target.permission, scope)) return 'forbidden';
  if (scope) {
    const [type] = await tx.select({ id: documentTypesTable.id }).from(documentTypesTable).where(eq(documentTypesTable.id, scope));
    if (!type) return 'not-found';
  }

  const values = { roleId: role.id, permissionId: permission.id };
  let changed;
  if (scope) {
    [changed] = grant
      ? await tx.insert(roleDocumentTypePermissionsTable).values({ ...values, documentTypeId: scope }).onConflictDoNothing()
        .returning({ roleId: roleDocumentTypePermissionsTable.roleId })
      : await tx.delete(roleDocumentTypePermissionsTable).where(and(eq(roleDocumentTypePermissionsTable.roleId, role.id),
        eq(roleDocumentTypePermissionsTable.permissionId, permission.id), eq(roleDocumentTypePermissionsTable.documentTypeId, scope)))
        .returning({ roleId: roleDocumentTypePermissionsTable.roleId });
  } else {
    [changed] = grant
      ? await tx.insert(rolePermissionsTable).values(values).onConflictDoNothing().returning({ roleId: rolePermissionsTable.roleId })
      : await tx.delete(rolePermissionsTable).where(and(eq(rolePermissionsTable.roleId, role.id),
        eq(rolePermissionsTable.permissionId, permission.id))).returning({ roleId: rolePermissionsTable.roleId });
  }
  if (changed) {
    await tx.insert(activityLogsTable).values({
      actorUserId: actorId, entityType: 'role', entityId: role.id,
      action: grant ? 'rbac.permission_granted' : 'rbac.permission_removed',
      metadata: { permission: target.permission, documentTypeId: scope },
    });
  }
  return 'ok';
}
