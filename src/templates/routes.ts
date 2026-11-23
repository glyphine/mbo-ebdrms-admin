import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { authenticate } from '../auth/access.js';
import { documentTemplatesTable, documentTypesTable, templateVersionsTable } from '../db/schema.js';
import { errorSchema, sendError } from '../http/errors.js';
import { bearerSecurity, recordSchema, uuid } from '../http/schemas.js';
import { hasGrant, userGrants } from '../rbac/permissions.js';

const text = { type: 'string' };
const versionMeta = recordSchema({
  templateId: uuid, documentTypeId: uuid, code: text, name: text, versionId: uuid,
  versionNumber: { type: 'integer' }, contentDigest: text,
});

const projection = {
  templateId: documentTemplatesTable.id, name: documentTemplatesTable.name,
  documentTypeId: documentTypesTable.id, code: documentTypesTable.code,
  versionId: templateVersionsTable.id, versionNumber: templateVersionsTable.versionNumber,
  contentDigest: templateVersionsTable.contentDigest,
};

export const templateRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); });

  app.get('/', {
    schema: {
      summary: 'List accessible active published templates', security: bearerSecurity,
      response: { 200: { type: 'array', items: versionMeta }, 401: errorSchema },
    },
  }, async (request) => {
    const grants = await userGrants(app.db, request.auth!.userId);
    const rows = await app.db.selectDistinctOn([documentTemplatesTable.id], projection).from(documentTemplatesTable)
      .innerJoin(documentTypesTable, eq(documentTypesTable.id, documentTemplatesTable.documentTypeId))
      .innerJoin(templateVersionsTable, eq(templateVersionsTable.templateId, documentTemplatesTable.id))
      .where(and(eq(documentTemplatesTable.isActive, true), eq(documentTypesTable.isActive, true), isNotNull(templateVersionsTable.contentDigest)))
      .orderBy(asc(documentTemplatesTable.id), desc(templateVersionsTable.versionNumber));
    return rows.filter(({ documentTypeId }) => hasGrant(grants, 'documents.read', documentTypeId) ||
      hasGrant(grants, 'documents.create', documentTypeId));
  });

  app.get<{ Params: { templateId: string; versionNumber: string } }>('/:templateId/versions/:versionNumber', {
    schema: {
      summary: 'Read the field schema and PDF defaults for a published version', security: bearerSecurity,
      params: recordSchema({ templateId: uuid, versionNumber: { type: 'string', pattern: '^[1-9][0-9]{0,9}$' } }),
      response: { 200: recordSchema({ ...versionMeta.properties, fieldSchema: { type: 'array', items: { type: 'object', additionalProperties: true } },
        pdfOptions: { type: 'object', additionalProperties: true } }), 400: errorSchema, 401: errorSchema, 404: errorSchema },
    },
  }, async (request, reply) => {
    const { templateId } = request.params;
    const number = Number(request.params.versionNumber);
    if (number > 2_147_483_647) return sendError(reply, 400, 'VALIDATION_ERROR', 'Version number is out of range');

    const grants = await userGrants(app.db, request.auth!.userId);
    const [version] = await app.db.select({ ...projection, templateActive: documentTemplatesTable.isActive,
      typeActive: documentTypesTable.isActive, fieldSchema: templateVersionsTable.fieldSchema, pdfOptions: templateVersionsTable.pdfOptions,
    }).from(documentTemplatesTable)
      .innerJoin(documentTypesTable, eq(documentTypesTable.id, documentTemplatesTable.documentTypeId))
      .innerJoin(templateVersionsTable, eq(templateVersionsTable.templateId, documentTemplatesTable.id))
      .where(and(eq(documentTemplatesTable.id, templateId), eq(templateVersionsTable.versionNumber, number),
        isNotNull(templateVersionsTable.contentDigest)));
    if (version && hasGrant(grants, 'documents.read', version.documentTypeId)) return version;
    if (version?.templateActive && version.typeActive && hasGrant(grants, 'documents.create', version.documentTypeId)) {
      const [latest] = await app.db.select({ id: templateVersionsTable.id }).from(templateVersionsTable)
        .where(and(eq(templateVersionsTable.templateId, templateId), isNotNull(templateVersionsTable.contentDigest)))
        .orderBy(desc(templateVersionsTable.versionNumber)).limit(1);
      if (latest?.id === version.versionId) return version;
    }
    return sendError(reply, 404, 'NOT_FOUND', 'Template version not found');
  });
};
