import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import swagger from '@fastify/swagger';
import Fastify from 'fastify';
import type { Config } from './config.js';
import { createDatabase } from './db/client.js';
import type { Database } from './db/client.js';
import { handleError, sendError } from './http/errors.js';
import { apiRoutes, registerHealth, registerPing } from './http/routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database['db'];
  }
}

interface AppOptions {
  database?: Database;
  logStream?: Writable;
}

export function createApp(config: Config, options: AppOptions = {}) {
  const app = Fastify({
    logger: {
      level: config.environment === 'test' && !options.logStream ? 'silent' : 'info',
      ...(options.logStream && { stream: options.logStream }),
      serializers: { req: (request) => ({ method: request.method }) },
      redact: [
        'req.headers', 'req.body', 'req.query', 'res.headers',
        'password', 'deviceCredential', 'accessToken', 'refreshToken', 'databaseUrl',
      ],
    },
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
    frameworkErrors: handleError,
  });

  const database = options.database ?? createDatabase(config.databaseUrl);
  database.onIdleError(() => app.log.error('Idle database connection failed'));
  app.decorate('db', database.db);
  app.addHook('onClose', async () => database.close());
  app.setErrorHandler(handleError);
  app.setNotFoundHandler(async (_request, reply) => {
    return sendError(reply, 404, 'NOT_FOUND', 'Route not found');
  });

  app.register(swagger, {
    openapi: { openapi: '3.0.3', info: { title: 'E-BDRMS API', version: '1.0.0' } },
  });
  app.register(async (routes) => {
    registerPing(routes, '/');
    registerHealth(routes, database.check);
    routes.register(apiRoutes, { prefix: '/api/v1' });
    routes.get('/openapi.json', { schema: { hide: true } }, async () => routes.swagger());
  });

  return app;
}
