import { STATUS_CODES } from 'node:http';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

export const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'requestId'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        requestId: { type: 'string' },
      },
    },
  },
};

export function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message, requestId: reply.request.id } });
}

export function handleError(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (error.validation) {
    return sendError(reply, 400, 'VALIDATION_ERROR', 'Request validation failed');
  }

  const status = error.statusCode ?? 500;
  if (status >= 400 && status < 500) {
    return sendError(reply, status, 'REQUEST_ERROR', STATUS_CODES[status] ?? 'Request failed');
  }

  request.log.error({ method: request.method, route: request.routeOptions?.url, status: 500 }, 'Request failed');
  return sendError(reply, 500, 'INTERNAL_ERROR', 'Internal server error');
}
