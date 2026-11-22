import { and, eq, gt } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, unauthorized } from '../auth/access.js';
import { rolesTable, userDevicesTable, usersTable } from '../db/schema.js';
import { errorSchema, sendError } from '../http/errors.js';
import { bearerSecurity, recordSchema, uuid } from '../http/schemas.js';
import { administer, changeDeviceStatus, changeDocumentGrant, changeRoleAssignment, setAccountActive } from './administration.js';
import { documentPermissions, forbidden, requirePermission } from './permissions.js';
import type { AdminPermission, DocumentPermission } from './permissions.js';

const pageSize = 50;
const pageQuery = { type: 'object', additionalProperties: false, properties: { after: uuid } };
type Page = { Querystring: { after?: string } };
const text = { type: 'string' };
const boolean = { type: 'boolean' };

function listSchema(summary: string, properties: Record<string, object>) {
  return {
    summary, security: bearerSecurity, querystring: pageQuery,
    response: { 200: { type: 'array', items: recordSchema(properties) }, 401: errorSchema, 403: errorSchema, 429: errorSchema },
  };
}

function mutationSchema(summary: string, params: Record<string, object>, body?: object) {
  return {
    summary, security: bearerSecurity, params: recordSchema(params), ...(body && { body }),
    response: {
      204: { type: 'null' }, 400: errorSchema, 401: errorSchema, 403: errorSchema,
      404: errorSchema, 409: errorSchema, 429: errorSchema,
    },
  };
}

async function mutate(request: FastifyRequest, reply: FastifyReply, permission: AdminPermission,
  mutation: Parameters<typeof administer>[3]) {
  if (!request.auth) return unauthorized(reply);
  const result = await administer(request.server.db, request.auth, permission, mutation);
  switch (result) {
    case 'ok': return reply.code(204).send();
    case 'unauthenticated': return unauthorized(reply.header('WWW-Authenticate', 'Bearer'));
    case 'forbidden': return forbidden(reply);
    case 'not-found': return sendError(reply, 404, 'NOT_FOUND', 'Resource not found');
    case 'conflict': return sendError(reply, 409, 'CONFLICT', 'Device state does not allow this operation');
  }
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.addHook('preHandler', authenticate);
  const rate = { rateLimit: { max: 60, timeWindow: '1 minute' } };

  app.get<Page>('/devices/pending', {
    config: rate, preHandler: requirePermission('devices.manage'),
    schema: listSchema('List pending device enrollments', { id: uuid, userId: uuid, label: text, createdAt: text }),
  }, async (request) => {
    const { after } = request.query;
    return app.db.select({ id: userDevicesTable.id, userId: userDevicesTable.userId,
      label: userDevicesTable.label, createdAt: userDevicesTable.createdAt })
      .from(userDevicesTable).where(and(eq(userDevicesTable.status, 'pending'), after ? gt(userDevicesTable.id, after) : undefined))
      .orderBy(userDevicesTable.id).limit(pageSize);
  });

  app.get<Page>('/users', {
    config: rate, preHandler: requirePermission('users.manage'),
    schema: listSchema('List user accounts', { id: uuid, email: text, fullName: text, isActive: boolean }),
  }, async (request) => {
    const { after } = request.query;
    return app.db.select({ id: usersTable.id, email: usersTable.email, fullName: usersTable.fullName, isActive: usersTable.isActive })
      .from(usersTable).where(after ? gt(usersTable.id, after) : undefined).orderBy(usersTable.id).limit(pageSize);
  });

  app.get<Page>('/roles', {
    config: rate, preHandler: requirePermission('roles.manage'),
    schema: listSchema('List roles', { id: uuid, name: text, description: { type: 'string', nullable: true } }),
  }, async (request) => {
    const { after } = request.query;
    return app.db.select({ id: rolesTable.id, name: rolesTable.name, description: rolesTable.description })
      .from(rolesTable).where(after ? gt(rolesTable.id, after) : undefined).orderBy(rolesTable.id).limit(pageSize);
  });

  for (const operation of ['approve', 'revoke'] as const) {
    app.post<{ Params: { deviceId: string } }>(`/devices/:deviceId/${operation}`, {
      config: rate, schema: mutationSchema(`${operation === 'approve' ? 'Approve' : 'Revoke'} device enrollment`, { deviceId: uuid }),
    }, (request, reply) => mutate(request, reply, 'devices.manage', (tx) =>
      changeDeviceStatus(tx, request.auth!.userId, request.params.deviceId, operation)));
  }

  app.patch<{ Params: { userId: string }; Body: { isActive: boolean } }>('/users/:userId/status', {
    config: rate, bodyLimit: 4096,
    schema: mutationSchema('Enable or disable a user account', { userId: uuid }, recordSchema({ isActive: boolean })),
  }, (request, reply) => mutate(request, reply, 'users.manage', (tx) =>
    setAccountActive(tx, request.auth!.userId, request.params.userId, request.body.isActive)));

  app.route<{ Params: { userId: string; roleId: string } }>({
    method: ['PUT', 'DELETE'], url: '/users/:userId/roles/:roleId', config: rate,
    schema: mutationSchema('Assign or remove an existing role', { userId: uuid, roleId: uuid }),
    handler: (request, reply) => mutate(request, reply, 'roles.manage', (tx, grants) =>
      changeRoleAssignment(tx, request.auth!.userId, grants, request.params, request.method === 'PUT')),
  });

  for (const scoped of [false, true]) {
    app.route<{ Params: { roleId: string; permission: DocumentPermission; documentTypeId?: string } }>({
      method: ['PUT', 'DELETE'], config: rate,
      url: scoped ? '/roles/:roleId/document-types/:documentTypeId/permissions/:permission' : '/roles/:roleId/permissions/:permission',
      schema: mutationSchema('Grant or remove a document permission on a role', {
        roleId: uuid, ...(scoped && { documentTypeId: uuid }), permission: { type: 'string', enum: documentPermissions },
      }),
      handler: (request, reply) => mutate(request, reply, 'roles.manage', (tx, grants) =>
        changeDocumentGrant(tx, request.auth!.userId, grants, request.params, request.method === 'PUT')),
    });
  }
};
