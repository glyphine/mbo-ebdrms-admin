import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { recordActivity } from '../audit/events.js';
import { authenticate } from '../auth/access.js';
import type { Database } from '../db/client.js';
import { errorSchema, sendError } from '../http/errors.js';
import { bearerSecurity, recordSchema, uuid } from '../http/schemas.js';
import { sendPdfFailure } from '../pdf/http.js';
import { PdfRenderError } from '../pdf/renderer.js';
import { dimensions, listFinancialSources, metricKeys, queryFinancialReport, ReportError } from './financial.js';
import type { FinancialQuery, FinancialReport } from './financial.js';
import { financialPrintView } from './print.js';

const text = { type: 'string' };
const integer = { type: 'integer' };
const nullableText = { ...text, nullable: true };
const nullableUuid = { ...uuid, nullable: true };
const date = { ...text, format: 'date', pattern: '^(?!0000)' };
const hash = { ...text, pattern: '^[0-9a-f]{64}$' };
const metric = { ...text, enum: metricKeys };
const dimension = { ...text, enum: dimensions };

const body = { ...recordSchema({ sourceDocumentId: uuid, fiscalYear: { ...integer, minimum: 1, maximum: 9999 }, fromDate: date, toDate: date,
  officeIds: { type: 'array', maxItems: 20, uniqueItems: true, items: nullableUuid },
  categories: { type: 'array', maxItems: 20, uniqueItems: true,
    items: { ...nullableText, maxLength: 160, pattern: '^[^\\u0000]*\\S[^\\u0000]*$' } },
  metrics: { type: 'array', minItems: 1, maxItems: 5, uniqueItems: true, items: metric }, groupBy: dimension,
  limit: { ...integer, minimum: 1, maximum: 50 }, offset: { ...integer, minimum: 0, maximum: 10_000 },
}), required: ['sourceDocumentId'] };

const period = recordSchema({ fiscalYear: { ...integer, nullable: true }, fromDate: nullableText, toDate: nullableText });
const source = recordSchema({ documentId: uuid, title: text, revisionId: uuid, revisionNumber: integer, templateVersionId: uuid,
  finalizedAt: text, period });
const office = recordSchema({ id: nullableUuid, label: text });
const amounts = { type: 'array', items: recordSchema({ metric, amount: nullableText }) };
const report = recordSchema({ source, periodMatched: { type: 'boolean' }, snapshotId: hash,
  filters: recordSchema({ ...period.properties, officeIds: { type: 'array', items: nullableUuid }, categories: { type: 'array', items: nullableText } }),
  facets: recordSchema({ offices: { type: 'array', items: office }, categories: { type: 'array', items: nullableText } }),
  metrics: { type: 'array', items: recordSchema({ metric, label: text, amount: nullableText }) },
  breakdown: recordSchema({ groupBy: dimension, totalGroups: integer, nextOffset: { ...integer, nullable: true },
    items: { type: 'array', items: recordSchema({ key: text, label: text, office: { ...office, nullable: true }, category: nullableText, values: amounts }) } }),
  chart: recordSchema({ groupBy: dimension, omittedGroups: integer,
    points: { type: 'array', items: recordSchema({ key: text, label: text, values: amounts }) } }),
});

const failures = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema, 422: errorSchema, 429: errorSchema };

function reportFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof PdfRenderError) return sendPdfFailure(reply, error);
  if (!(error instanceof ReportError)) throw error;
  const code = { 400: 'VALIDATION_ERROR', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 422: 'REPORT_UNAVAILABLE' }[error.status];
  return sendError(reply, error.status, code, error.message);
}

function auditReport(db: Database['db'], actor: string, report: FinancialReport, action: string) {
  return recordActivity(db, { actorUserId: actor, entityType: 'financial_report', entityId: report.source.documentId, action,
    metadata: { revisionId: report.source.revisionId, snapshotId: report.snapshotId, filters: report.filters,
      metrics: report.metrics.map(({ metric }) => metric), groupBy: report.breakdown.groupBy } });
}

export const financialReportRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); });
  app.addHook('preHandler', authenticate);

  app.get<{ Querystring: { fiscalYear?: string; after?: string; limit?: string } }>('/sources', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { summary: 'List available authoritative financial report sources', security: bearerSecurity,
      querystring: { ...recordSchema({ fiscalYear: { ...text, pattern: '^[1-9][0-9]{0,3}$' }, after: uuid,
        limit: { ...text, pattern: '^(?:[1-9]|[1-4][0-9]|50)$' } }), required: [] },
      response: { 200: recordSchema({ items: { type: 'array', items: source }, nextAfter: nullableUuid }), ...failures } },
  }, async (request, reply) => {
    try {
      const { fiscalYear, after, limit } = request.query;
      return await listFinancialSources(app.db, request.auth!.userId, { ...(fiscalYear && { fiscalYear: Number(fiscalYear) }),
        ...(after && { after }), limit: Number(limit ?? 25) });
    } catch (error) {
      return reportFailure(reply, error);
    }
  });

  app.post<{ Body: FinancialQuery }>('/', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, bodyLimit: 8192,
    schema: { summary: 'Query exact financial cards, breakdowns and chart data', security: bearerSecurity, body,
      response: { 200: report, ...failures } },
  }, async (request, reply) => {
    try {
      const actor = request.auth!.userId;
      const result = await queryFinancialReport(app.db, actor, request.body);
      await auditReport(app.db, actor, result, 'report.financial_viewed');
      return result;
    } catch (error) {
      return reportFailure(reply, error);
    }
  });

  app.post<{ Body: FinancialQuery & { expectedSnapshotId?: string } }>('/pdf', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, bodyLimit: 8192,
    schema: { summary: 'Download the selected financial dashboard as a private PDF', security: bearerSecurity,
      body: { ...body, properties: { ...body.properties, expectedSnapshotId: hash } }, response: {
        200: { content: { 'application/pdf': { schema: { ...text, format: 'binary' } } } }, ...failures, 503: errorSchema, 504: errorSchema,
      } },
  }, async (request, reply) => {
    try {
      const actor = request.auth!.userId;
      const result = await queryFinancialReport(app.db, actor, request.body, true);
      if (request.body.expectedSnapshotId && request.body.expectedSnapshotId !== result.snapshotId) {
        throw new ReportError(409, 'The selected financial snapshot changed');
      }
      const pdf = await app.pdfRenderer.renderReport(financialPrintView(result));
      await auditReport(app.db, actor, result, 'report.financial_pdf_exported');
      return reply.type('application/pdf').header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename="financial-report-${result.source.documentId}-r${result.source.revisionNumber}.pdf"`)
        .header('X-Report-Snapshot', result.snapshotId).send(pdf);
    } catch (error) {
      return reportFailure(reply, error);
    }
  });
};
