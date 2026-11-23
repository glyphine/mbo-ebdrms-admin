import type { FastifyPluginAsync } from 'fastify';
import { authenticate } from '../auth/access.js';
import { errorSchema, sendError } from '../http/errors.js';
import { bearerSecurity, recordSchema, uuid } from '../http/schemas.js';
import { requirePermission } from '../rbac/permissions.js';
import { AuditQueryError, auditStreams, listAuditEvents, recordActivity } from './events.js';
import type { AuditQuery } from './events.js';

const text = { type: 'string' };
const date = { ...text, format: 'date', pattern: '^(?!0000)' };
const filterText = { ...text, maxLength: 100, pattern: '^[^\\u0000]+$' };
const querySchema = recordSchema({ stream: { ...text, enum: auditStreams }, actorUserId: uuid,
  targetType: filterText, targetId: { ...filterText, maxLength: 255 }, action: filterText, fromDate: date, toDate: date,
  after: { ...text, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' }, limit: { ...text, pattern: '^(?:[1-9]|[1-4][0-9]|50)$' },
});

export const auditRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); });
  app.get<{ Querystring: Omit<AuditQuery, 'stream' | 'limit'> & { stream?: AuditQuery['stream']; limit?: string } }>('/events', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    preHandler: [authenticate, requirePermission('audit.read')],
    schema: { summary: 'Read the append-only audit event stream', security: bearerSecurity, querystring: { ...querySchema, required: [] },
      response: { 200: recordSchema({ stream: text, nextAfter: { ...text, nullable: true }, items: { type: 'array',
        items: recordSchema({ id: uuid, actorUserId: { ...uuid, nullable: true }, targetType: { ...text, nullable: true },
          targetId: { ...text, nullable: true }, action: text, timestamp: text }) } }),
      400: errorSchema, 401: errorSchema, 403: errorSchema, 429: errorSchema } },
  }, async (request, reply) => {
    try {
      const stream = request.query.stream ?? 'activity';
      const result = await listAuditEvents(app.db, { ...request.query, stream, limit: Number(request.query.limit ?? 25) });
      await recordActivity(app.db, { actorUserId: request.auth!.userId, entityType: 'audit_stream', entityId: stream,
        action: 'audit.events_viewed', metadata: { resultCount: result.items.length } });
      return result;
    } catch (error) {
      if (error instanceof AuditQueryError) return sendError(reply, 400, 'VALIDATION_ERROR', error.message);
      throw error;
    }
  });
};
