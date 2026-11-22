import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { errorSchema, sendError } from './errors.js';

export function registerPing(app: FastifyInstance, path: string) {
  app.get<{ Querystring: { name?: string } }>(path, {
    schema: {
      summary: 'Check that the API responds',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string', maxLength: 100 } },
      },
      response: {
        200: {
          type: 'object',
          required: ['hello'],
          properties: { hello: { type: 'string' } },
        },
        400: errorSchema,
      },
    },
  }, async (request) => ({ hello: request.query.name || 'world' }));
}

export const apiRoutes: FastifyPluginAsync = async (app) => {
  registerPing(app, '/ping');
};

const healthSchema = {
  type: 'object',
  required: ['status'],
  properties: { status: { type: 'string', enum: ['ok'] } },
};

export function registerHealth(app: FastifyInstance, checkDatabase: () => Promise<void>) {
  app.get('/health/live', {
    schema: { summary: 'Check process liveness', response: { 200: healthSchema } },
  }, async () => ({ status: 'ok' }));

  app.get('/health/ready', {
    schema: { summary: 'Check database readiness', response: { 200: healthSchema, 503: errorSchema } },
  }, async (request, reply) => {
    try {
      await checkDatabase();
      return { status: 'ok' };
    } catch {
      request.log.warn('Database readiness check failed');
      return sendError(reply, 503, 'SERVICE_UNAVAILABLE', 'Database unavailable');
    }
  });
}
