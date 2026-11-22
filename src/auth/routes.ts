import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { errorSchema, sendError } from '../http/errors.js';
import { bearerSecurity, recordSchema, uuid } from '../http/schemas.js';
import { accessLifetimeSeconds, authenticate, issueAccessToken, unauthorized } from './access.js';
import { maxPasswordLength } from './password.js';
import { enrollDevice, login, logout, refresh, revokeDeviceSessions } from './service.js';
import type { SessionIdentity } from './service.js';

const passwordFields = {
  email: { type: 'string', format: 'email', maxLength: 255 },
  password: { type: 'string', minLength: 1, maxLength: maxPasswordLength, writeOnly: true },
};
const opaqueSecret = { type: 'string', minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]{43}$' };
const deviceProofFields = { deviceId: uuid, deviceCredential: { ...opaqueSecret, writeOnly: true } };

type PasswordInput = { email: string; password: string };
type DeviceProof = { deviceId: string; deviceCredential: string };

const tokenResponse = recordSchema({
  accessToken: { type: 'string' }, refreshToken: opaqueSecret,
  tokenType: { type: 'string', enum: ['Bearer'] }, expiresIn: { type: 'integer' },
});

async function sendTokens(reply: FastifyReply, tokens: SessionIdentity & { refreshToken: string }) {
  return reply.send({
    accessToken: await issueAccessToken(reply, tokens), refreshToken: tokens.refreshToken,
    tokenType: 'Bearer', expiresIn: accessLifetimeSeconds,
  });
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });

  app.post<{ Body: PasswordInput & { label: string } }>('/enroll', {
    bodyLimit: 4096,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: {
      summary: 'Request pending device enrollment after password verification',
      body: recordSchema({ ...passwordFields, label: { type: 'string', maxLength: 100, pattern: '^[^\\u0000]*\\S[^\\u0000]*$' } }),
      response: {
        201: recordSchema({ deviceId: uuid, status: { type: 'string', enum: ['pending'] }, deviceCredential: opaqueSecret }),
        400: errorSchema, 401: errorSchema, 429: errorSchema,
      },
    },
  }, async (request, reply) => {
    const device = await enrollDevice(app.db, request.body);
    if (!device) return unauthorized(reply);
    return reply.code(201).send({ deviceId: device.deviceId, status: device.status, deviceCredential: device.credential });
  });

  app.post<{ Body: PasswordInput & DeviceProof }>('/login', {
    bodyLimit: 4096,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      summary: 'Sign in with an approved device and password',
      body: recordSchema({ ...passwordFields, ...deviceProofFields }),
      response: { 200: tokenResponse, 400: errorSchema, 401: errorSchema, 429: errorSchema },
    },
  }, async (request, reply) => {
    const tokens = await login(app.db, request.body);
    return tokens ? sendTokens(reply, tokens) : unauthorized(reply);
  });

  app.post<{ Body: DeviceProof & { refreshToken: string } }>('/refresh', {
    bodyLimit: 4096,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      summary: 'Rotate the refresh token with proof of the enrolled device credential',
      body: recordSchema({ ...deviceProofFields, refreshToken: { ...opaqueSecret, writeOnly: true } }),
      response: { 200: tokenResponse, 400: errorSchema, 401: errorSchema, 429: errorSchema },
    },
  }, async (request, reply) => {
    const tokens = await refresh(app.db, request.body);
    return tokens ? sendTokens(reply, tokens) : unauthorized(reply);
  });

  app.get('/me', {
    preHandler: authenticate,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: {
      summary: 'Get the active session identity', security: bearerSecurity,
      response: { 200: recordSchema({ userId: uuid, sessionId: uuid, deviceId: uuid }), 401: errorSchema, 429: errorSchema },
    },
  }, async (request) => request.auth);

  app.post('/logout', {
    preHandler: authenticate,
    bodyLimit: 4096,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      summary: 'Revoke the current session', security: bearerSecurity,
      response: { 204: { type: 'null' }, 401: errorSchema, 429: errorSchema },
    },
  }, async (request, reply) => {
    await logout(app.db, request.auth!);
    return reply.code(204).send();
  });

  app.delete<{ Params: { deviceId: string } }>('/devices/:deviceId/sessions', {
    preHandler: authenticate,
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
    schema: {
      summary: 'Revoke all sessions on a device owned by the current account', security: bearerSecurity,
      params: recordSchema({ deviceId: uuid }),
      response: { 204: { type: 'null' }, 400: errorSchema, 401: errorSchema, 404: errorSchema, 429: errorSchema },
    },
  }, async (request, reply) => {
    if (!await revokeDeviceSessions(app.db, request.auth!.userId, request.params.deviceId)) {
      return sendError(reply, 404, 'NOT_FOUND', 'Device not found');
    }
    return reply.code(204).send();
  });
};
