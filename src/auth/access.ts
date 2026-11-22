import { randomUUID } from 'node:crypto';
import type { FastifyJWTOptions, TokenOrHeader } from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { sendError } from '../http/errors.js';
import { activeSession } from './service.js';
import type { SessionIdentity } from './service.js';

export const accessLifetimeSeconds = 600;
const tokenType = 'at+jwt';
const uuidPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && uuidPattern.test(value);

declare module 'fastify' {
  interface FastifyRequest {
    auth: SessionIdentity | null;
  }
}

export function accessJwtOptions(config: Config['jwt']): FastifyJWTOptions {
  return {
    async secret(_request: FastifyRequest, token: TokenOrHeader) {
      const kid = 'header' in token ? token.header.kid : config.activeKid;
      const key = typeof kid === 'string' ? config.keys.get(kid) : undefined;
      if (!key) throw new Error('Unknown JWT signing key');
      return key;
    },
    decode: { complete: true, checkTyp: tokenType },
    sign: {
      algorithm: 'HS256', kid: config.activeKid, header: { alg: 'HS256', typ: tokenType },
      iss: config.issuer, aud: config.audience, expiresIn: accessLifetimeSeconds,
    },
    verify: {
      algorithms: ['HS256'], checkTyp: tokenType, allowedIss: config.issuer, allowedAud: config.audience,
      requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'sid', 'did', 'jti'],
    },
  };
}

export function issueAccessToken(reply: FastifyReply, identity: SessionIdentity) {
  return reply.jwtSign({ sub: identity.userId, sid: identity.sessionId, did: identity.deviceId, jti: randomUUID() });
}

export function unauthorized(reply: FastifyReply) {
  return sendError(reply, 401, 'AUTHENTICATION_FAILED', 'Authentication failed');
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  let claims: Record<string, unknown>;
  try {
    claims = await request.jwtVerify<Record<string, unknown>>();
  } catch {
    return unauthorized(reply.header('WWW-Authenticate', 'Bearer'));
  }

  const { sub, sid, did, jti, iat, exp } = claims;
  if (!isUuid(sub) || !isUuid(sid) || !isUuid(did) || !isUuid(jti) ||
      typeof iat !== 'number' || !Number.isSafeInteger(iat) ||
      typeof exp !== 'number' || !Number.isSafeInteger(exp) ||
      iat > Math.floor(Date.now() / 1000) || exp <= iat || exp - iat > accessLifetimeSeconds) {
    return unauthorized(reply.header('WWW-Authenticate', 'Bearer'));
  }

  const identity = { userId: sub, sessionId: sid, deviceId: did };
  if (!await activeSession(request.server.db, identity)) {
    return unauthorized(reply.header('WWW-Authenticate', 'Bearer'));
  }
  request.auth = identity;
}
