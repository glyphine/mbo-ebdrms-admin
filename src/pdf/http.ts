import type { FastifyReply } from 'fastify';
import { sendError } from '../http/errors.js';
import { PdfRenderError } from './renderer.js';

export function sendPdfFailure(reply: FastifyReply, error: PdfRenderError) {
  switch (error.kind) {
    case 'busy': return sendError(reply.header('Retry-After', '1'), 503, 'PDF_BUSY', 'PDF renderer is at capacity');
    case 'timeout': return sendError(reply, 504, 'PDF_TIMEOUT', 'PDF rendering timed out');
    case 'limit': return sendError(reply, 422, 'PDF_LIMIT', 'PDF exceeds render limits');
    case 'render': throw error;
  }
}
