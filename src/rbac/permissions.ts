import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { unauthorized } from '../auth/access.js';
import type { Database } from '../db/client.js';
import { documentTemplatesTable, documentsTable, documentTypesTable, permissionsTable, roleDocumentTypePermissionsTable,
  rolePermissionsTable, userRolesTable, usersTable } from '../db/schema.js';
import { sendError } from '../http/errors.js';

type PermissionDatabase = Pick<Database['db'], 'select'>;
export type Grant = { name: string; documentTypeId: string | null };

export const adminPermissions = ['devices.manage', 'users.manage', 'roles.manage'] as const;
export type AdminPermission = typeof adminPermissions[number];
export const documentPermissions = [
  'documents.create', 'documents.read', 'documents.revise', 'documents.finalize', 'documents.void', 'documents.export', 'documents.archive',
] as const;
export type DocumentPermission = typeof documentPermissions[number];
export type RecordPermission = Exclude<DocumentPermission, 'documents.create'>;
type DocumentStatus = typeof documentsTable.$inferSelect.status;

const permittedStatuses: Record<RecordPermission, readonly DocumentStatus[]> = {
  'documents.read': ['draft', 'finalized', 'voided', 'archived'],
  'documents.revise': ['draft'],
  'documents.finalize': ['draft'],
  'documents.void': ['finalized'],
  'documents.export': ['draft', 'finalized', 'archived'],
  'documents.archive': ['finalized'],
};

export function permitsDocumentStatus(permission: RecordPermission, status: DocumentStatus) {
  return permittedStatuses[permission]?.includes(status) ?? false;
}

function readGrants(db: PermissionDatabase, globalRoles: SQL, scopedRoles: SQL) {
  // Drizzle wraps the union in a SELECT. Alias the NULL so that wrapper reads the actual scope column.
  return db.select({ name: permissionsTable.name, documentTypeId: sql<string | null>`null::uuid`.as('document_type_id') })
    .from(rolePermissionsTable).innerJoin(permissionsTable, eq(permissionsTable.id, rolePermissionsTable.permissionId))
    .where(globalRoles).unionAll(
      db.select({ name: permissionsTable.name, documentTypeId: roleDocumentTypePermissionsTable.documentTypeId })
        .from(roleDocumentTypePermissionsTable)
        .innerJoin(permissionsTable, eq(permissionsTable.id, roleDocumentTypePermissionsTable.permissionId))
        .where(scopedRoles),
    );
}

export function userGrants(db: PermissionDatabase, userId: string, includeInactive = false) {
  const memberships = db.select({ roleId: userRolesTable.roleId }).from(userRolesTable)
    .innerJoin(usersTable, eq(usersTable.id, userRolesTable.userId))
    .where(and(eq(userRolesTable.userId, userId), includeInactive ? undefined : eq(usersTable.isActive, true)));
  return readGrants(db, inArray(rolePermissionsTable.roleId, memberships),
    inArray(roleDocumentTypePermissionsTable.roleId, memberships));
}

export function roleGrants(db: PermissionDatabase, roleId: string) {
  return readGrants(db, eq(rolePermissionsTable.roleId, roleId), eq(roleDocumentTypePermissionsTable.roleId, roleId));
}

export function hasGrant(grants: readonly Grant[], name: string, documentTypeId?: string | null) {
  const documentScope = !!documentTypeId && documentPermissions.some((permission) => permission === name);
  return grants.some((grant) => grant.name === name &&
    (grant.documentTypeId === null || (documentScope && grant.documentTypeId === documentTypeId)));
}

export function forbidden(reply: FastifyReply) {
  return sendError(reply, 403, 'FORBIDDEN', 'Permission denied');
}

// The route must run authenticate before this guard.
export function requirePermission(name: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth) return unauthorized(reply);
    if (!hasGrant(await userGrants(request.server.db, request.auth.userId), name)) return forbidden(reply);
  };
}

export async function authorizeDocumentType(db: PermissionDatabase, userId: string, documentTypeId: string, permission: DocumentPermission) {
  if (!documentPermissions.includes(permission)) return false;
  const [type] = await db.select({ id: documentTypesTable.id, active: documentTypesTable.isActive })
    .from(documentTypesTable).where(eq(documentTypesTable.id, documentTypeId));
  return !!type && (permission !== 'documents.create' || type.active) &&
    hasGrant(await userGrants(db, userId), permission, type.id);
}

// Resolve the scope from the actual record. Write callers must still enforce the expected status in their transaction.
export async function authorizeDocument(db: PermissionDatabase, userId: string, documentId: string, permission: RecordPermission) {
  const [record] = await db.select({
    id: documentsTable.id, templateId: documentsTable.templateId, status: documentsTable.status,
    documentTypeId: documentTemplatesTable.documentTypeId,
  }).from(documentsTable).innerJoin(documentTemplatesTable, eq(documentTemplatesTable.id, documentsTable.templateId))
    .where(eq(documentsTable.id, documentId));
  if (!record || !permitsDocumentStatus(permission, record.status)) return undefined;
  return hasGrant(await userGrants(db, userId), permission, record.documentTypeId) ? record : undefined;
}
