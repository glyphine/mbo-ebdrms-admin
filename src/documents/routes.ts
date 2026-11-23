import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { authenticate } from '../auth/access.js';
import { errorSchema, sendError } from '../http/errors.js';
import { bearerSecurity, recordSchema, uuid } from '../http/schemas.js';
import { PdfRenderError, PdfRenderer } from '../pdf/renderer.js';
import { exportRevisionPdf } from '../pdf/service.js';
import { DocumentValidationError } from '../templates/validation.js';
import { changeDocument, createDocument, DocumentError, listDocuments, listRevisions, readDocument, readRevision } from './service.js';
import type { ChangeInput, CreateInput } from './service.js';

const maxRevision = 2_147_483_647;
const revisionNumber = { type: 'integer', minimum: 1, maximum: maxRevision };
const numberParam = { type: 'string', pattern: '^[1-9][0-9]{0,9}$' };
const text = { type: 'string' };
const nullableText = { ...text, nullable: true };
const nullableUuid = { ...uuid, nullable: true };
const payloadValues = { type: 'object', additionalProperties: true };
const changeNote = { ...nullableText, maxLength: 1000, pattern: '^[^\\u0000]*$' };
const snapshots = {
  type: 'array', items: recordSchema({ signatoryId: nullableUuid, slotKey: text, displayName: text,
    displayDesignation: text, displayDate: nullableText }),
};
const signatories = {
  type: 'array', maxItems: 4,
  items: { ...recordSchema({ slotKey: { type: 'string', maxLength: 20 }, signatoryId: uuid,
    date: { type: 'string', format: 'date', nullable: true } }), required: ['slotKey', 'signatoryId'] },
};
const documentParams = recordSchema({ documentId: uuid });
const identity = recordSchema({ id: uuid, templateId: uuid, documentTypeId: uuid, documentTypeCode: text,
  createdBy: uuid, managingOfficeId: nullableUuid, title: text, description: nullableText, referenceNumber: nullableText,
  fiscalYear: { type: 'integer', nullable: true }, status: text, currentRevision: { ...revisionNumber, nullable: true },
  createdAt: text, updatedAt: text });
const revision = recordSchema({ id: uuid, documentId: uuid, templateVersionId: uuid, revisionNumber,
  status: text, changeNote: nullableText, createdBy: uuid, createdAt: text });
const draftFields = { values: payloadValues, signatories, changeNote };
const failure = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema };
const draftLimit = 1024 * 1024;

type DocumentParams = { Params: { documentId: string } };
type RevisionBody = Omit<Extract<ChangeInput, { operation: 'revise' }>, 'operation'>;
type TransitionBody = { expectedRevision: number; changeNote?: string | null };

async function respond(reply: FastifyReply, work: () => Promise<unknown>, status = 200) {
  try {
    const body = await work();
    return reply.code(status).send(body);
  } catch (error) {
    if (error instanceof PdfRenderError) {
      switch (error.kind) {
        case 'busy': return sendError(reply.header('Retry-After', '1'), 503, 'PDF_BUSY', 'PDF renderer is at capacity');
        case 'timeout': return sendError(reply, 504, 'PDF_TIMEOUT', 'PDF rendering timed out');
        case 'limit': return sendError(reply, 422, 'PDF_LIMIT', 'Document exceeds PDF limits');
        case 'render': throw error;
      }
    }
    if (error instanceof DocumentValidationError) return sendError(reply, 400, 'VALIDATION_ERROR', error.message);
    if (error instanceof DocumentError) {
      const code = { 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT' }[error.status];
      return sendError(reply, error.status, code, error.message);
    }
    throw error;
  }
}

export const documentRoutes: FastifyPluginAsync = async (app) => {
  const renderer = new PdfRenderer();
  app.addHook('onClose', () => renderer.close());
  app.addHook('preHandler', authenticate);
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); });

  app.post<{ Body: CreateInput }>('/', {
    bodyLimit: draftLimit,
    schema: { summary: 'Create a document and its first draft revision', security: bearerSecurity,
      body: { ...recordSchema({ ...draftFields, templateVersionId: uuid,
        title: { ...text, maxLength: 255, pattern: '^[^\\u0000]*\\S[^\\u0000]*$' },
        description: { ...nullableText, maxLength: 2000, pattern: '^[^\\u0000]*$' }, managingOfficeId: nullableUuid,
        referenceNumber: { ...nullableText, maxLength: 100, pattern: '^[^\\u0000]*$' },
        fiscalYear: { type: 'integer', minimum: 1, maximum: 9999, nullable: true } }), required: ['title', 'templateVersionId', 'values'] },
      response: { 201: identity, ...failure } },
  }, (request, reply) => respond(reply, () => createDocument(app.db, request.auth!.userId, request.body), 201));

  app.get<{ Querystring: { after?: string } }>('/', {
    schema: { summary: 'List readable documents', security: bearerSecurity,
      querystring: { ...recordSchema({ after: uuid }), required: [] },
      response: { 200: { type: 'array', items: identity }, ...failure } },
  }, (request, reply) => respond(reply, () => listDocuments(app.db, request.auth!.userId, request.query.after)));

  app.get<DocumentParams>('/:documentId', {
    schema: { summary: 'Read document metadata', security: bearerSecurity, params: documentParams, response: { 200: identity, ...failure } },
  }, (request, reply) => respond(reply, () => readDocument(app.db, request.auth!.userId, request.params.documentId)));

  app.get<DocumentParams & { Querystring: { after?: string } }>('/:documentId/revisions', {
    schema: { summary: 'List immutable revision metadata', security: bearerSecurity, params: documentParams,
      querystring: { ...recordSchema({ after: numberParam }), required: [] }, response: { 200: { type: 'array', items: revision }, ...failure } },
  }, (request, reply) => {
    const after = Number(request.query.after ?? 0);
    if (after > maxRevision) return sendError(reply, 400, 'VALIDATION_ERROR', 'Revision number is out of range');
    return respond(reply, () => listRevisions(app.db, request.auth!.userId, request.params.documentId, after));
  });

  app.get<{ Params: { documentId: string; revisionNumber: string } }>('/:documentId/revisions/:revisionNumber', {
    schema: { summary: 'Read an exact immutable revision', security: bearerSecurity, params: recordSchema({ documentId: uuid, revisionNumber: numberParam }),
      response: { 200: recordSchema({ ...revision.properties, values: payloadValues, signatories: snapshots }), ...failure } },
  }, (request, reply) => {
    const number = Number(request.params.revisionNumber);
    if (number > maxRevision) return sendError(reply, 400, 'VALIDATION_ERROR', 'Revision number is out of range');
    return respond(reply, () => readRevision(app.db, request.auth!.userId, request.params.documentId, number));
  });

  app.get<{ Params: { documentId: string; revisionNumber: string } }>('/:documentId/revisions/:revisionNumber/pdf', {
    exposeHeadRoute: false,
    schema: { summary: 'Download a PDF of an exact immutable revision', security: bearerSecurity,
      params: recordSchema({ documentId: uuid, revisionNumber: numberParam }),
      response: { 200: { content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } },
        ...failure, 422: errorSchema, 503: errorSchema, 504: errorSchema } },
  }, (request, reply) => {
    const number = Number(request.params.revisionNumber);
    if (number > maxRevision) return sendError(reply, 400, 'VALIDATION_ERROR', 'Revision number is out of range');
    return respond(reply, async () => {
      try {
        const { pdf, filename } = await exportRevisionPdf(app.db, renderer, request.auth!.userId, request.params.documentId, number);
        reply.type('application/pdf').header('Content-Disposition', `attachment; filename="${filename}"`)
          .header('X-Content-Type-Options', 'nosniff');
        return pdf;
      } catch (error) {
        if (error instanceof DocumentValidationError) throw new PdfRenderError('render', { cause: error });
        throw error;
      }
    });
  });

  app.post<DocumentParams & { Body: RevisionBody }>('/:documentId/revisions', {
    bodyLimit: draftLimit,
    schema: { summary: 'Append a replacement draft using the expected revision', security: bearerSecurity, params: documentParams,
      body: { ...recordSchema({ ...draftFields, expectedRevision: revisionNumber }), required: ['values', 'expectedRevision'] },
      response: { 201: identity, ...failure } },
  }, (request, reply) => respond(reply, () => changeDocument(app.db, request.auth!.userId, request.params.documentId,
    { ...request.body, operation: 'revise' }), 201));

  for (const operation of ['finalize', 'archive'] as const) {
    app.post<DocumentParams & { Body: TransitionBody }>(`/:documentId/${operation}`, {
      bodyLimit: 8192,
      schema: { summary: operation === 'finalize' ? 'Append a finalized revision' : 'Archive a finalized document',
        security: bearerSecurity, params: documentParams,
        body: { ...recordSchema({ expectedRevision: revisionNumber, changeNote }), required: ['expectedRevision'] },
        response: { 200: identity, ...failure } },
    }, (request, reply) => respond(reply, () => changeDocument(app.db, request.auth!.userId, request.params.documentId,
      { ...request.body, operation })));
  }
};
