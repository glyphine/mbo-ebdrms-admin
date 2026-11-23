import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { activityLogsTable, documentFinancialValuesTable, documentRevisionsTable, documentRevisionSignatoriesTable,
  documentsTable, documentTemplatesTable, documentTypesTable, officesTable, signatoriesTable, templateVersionsTable } from '../db/schema.js';
import { hasGrant, permitsDocumentStatus, userGrants } from '../rbac/permissions.js';
import { loadPublishedTemplateVersion } from '../templates/publication.js';
import type { DocValues, TemplateCode } from '../templates/contracts.js';
import { DocumentValidationError, validateDocumentValues } from '../templates/validation.js';
import { deriveFinancialValues, projectFinancialValues, statementOfficeCodes } from './financials.js';

type Db = Database['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Document = typeof documentsTable.$inferSelect;
type Published = NonNullable<Awaited<ReturnType<typeof loadPublishedTemplateVersion>>>;
type Revision = typeof documentRevisionsTable.$inferSelect;
type SignatoryInput = { slotKey: string; signatoryId: string; date?: string | null };
type DraftInput = { values: unknown; signatories?: SignatoryInput[]; changeNote?: string | null };
export type CreateInput = DraftInput & { templateVersionId: string; title: string; description?: string | null;
  managingOfficeId?: string | null; referenceNumber?: string | null; fiscalYear?: number | null };
export type ChangeInput = { expectedRevision: number; changeNote?: string | null } & (
  | (DraftInput & { operation: 'revise' })
  | { operation: 'finalize' | 'archive' }
);

export class DocumentError extends Error {
  constructor(readonly status: 403 | 404 | 409, message: string) { super(message); }
}

function notFound(): never { throw new DocumentError(404, 'Document not found'); }

const signatoryColumns = {
  signatoryId: documentRevisionSignatoriesTable.signatoryId, slotKey: documentRevisionSignatoriesTable.slotKey,
  displayName: documentRevisionSignatoriesTable.displayName, displayDesignation: documentRevisionSignatoriesTable.displayDesignation,
  displayDate: documentRevisionSignatoriesTable.displayDate,
};
const financialColumns = {
  fieldPath: documentFinancialValuesTable.fieldPath, metricKey: documentFinancialValuesTable.metricKey,
  officeId: documentFinancialValuesTable.officeId, accountCode: documentFinancialValuesTable.accountCode,
  fiscalYear: documentFinancialValuesTable.fiscalYear, amount: documentFinancialValuesTable.amount,
  isAggregate: documentFinancialValuesTable.isAggregate,
};
type Financial = Omit<typeof documentFinancialValuesTable.$inferInsert, 'id' | 'revisionId'>;
type Signatory = Omit<typeof documentRevisionSignatoriesTable.$inferSelect, 'id' | 'revisionId'>;

function signatorySlots(code: TemplateCode) {
  if (code === 'CAFOA') return ['official', 'signatory1', 'signatory2', 'signatory3'];
  if (code === 'SAAOB') return ['preparedBy', 'certifiedBy'];
  return [];
}

function revisionSignatories(db: Pick<Db, 'select'>, revisionId: string) {
  return db.select(signatoryColumns).from(documentRevisionSignatoriesTable)
    .where(eq(documentRevisionSignatoriesTable.revisionId, revisionId)).orderBy(asc(documentRevisionSignatoriesTable.slotKey));
}

async function snapshotSignatories(tx: Tx, code: TemplateCode, inputs: SignatoryInput[]) {
  const slots = signatorySlots(code);
  const used = new Set<string>();
  for (const input of inputs) {
    if (!slots.includes(input.slotKey) || used.has(input.slotKey) || (input.date != null && code !== 'CAFOA')) {
      throw new DocumentValidationError('Invalid or duplicate signatory slot');
    }
    used.add(input.slotKey);
  }
  if (!inputs.length) return [];
  const people = await tx.select({ id: signatoriesTable.id, fullName: signatoriesTable.fullName, designation: signatoriesTable.designation })
    .from(signatoriesTable).where(and(eq(signatoriesTable.isActive, true),
      inArray(signatoriesTable.id, inputs.map(({ signatoryId }) => signatoryId))));
  return inputs.map(({ signatoryId, slotKey, date }) => {
    const person = people.find(({ id }) => id === signatoryId.toLowerCase());
    if (!person) throw new DocumentValidationError('Signatory must be an active registry record');
    return { slotKey, signatoryId: person.id, displayName: person.fullName, displayDesignation: person.designation, displayDate: date ?? null };
  });
}

async function prepareDraft(tx: Tx, template: Published, input: DraftInput, fiscalYear: number | null, baseRevisionId?: string) {
  const code = template.renderSnapshot.code;
  const values = validateDocumentValues(template.fieldSchema, input.values);
  const keys = signatorySlots(code).flatMap((slot) => [`${slot}Name`, `${slot}Title`, `${slot}Date`]);
  if (keys.some((key) => Object.hasOwn(values, key))) throw new DocumentValidationError('Supply signatories using registry IDs and slot keys');
  const signatories = input.signatories === undefined && baseRevisionId
    ? await revisionSignatories(tx, baseRevisionId) : await snapshotSignatories(tx, code, input.signatories ?? []);
  for (const snapshot of signatories) {
    values[`${snapshot.slotKey}Name`] = snapshot.displayName;
    values[`${snapshot.slotKey}Title`] = snapshot.displayDesignation;
    if (code === 'CAFOA' && snapshot.displayDate !== null) values[`${snapshot.slotKey}Date`] = snapshot.displayDate;
  }
  const aggregates = deriveFinancialValues(code, values);
  const validated = validateDocumentValues(template.fieldSchema, values);
  const officeCodes = code === 'SAAOB' ? statementOfficeCodes(validated) : [];
  const offices = officeCodes.length ? await tx.select({ id: officesTable.id, code: officesTable.code }).from(officesTable)
    .where(inArray(officesTable.code, officeCodes)) : [];
  if (offices.length !== officeCodes.length) throw new DocumentValidationError('SAAOB office codes must exist in the office registry');
  const financial = projectFinancialValues(template.fieldSchema, validated, aggregates, new Map(offices.map(({ id, code }) => [code, id])))
    .map((value) => ({ ...value, fiscalYear }));
  return { values: validated, signatories, financial };
}

async function appendRevision(tx: Tx, row: typeof documentRevisionsTable.$inferInsert, signatories: Signatory[], financial: Financial[]) {
  const [revision] = await tx.insert(documentRevisionsTable).values(row).returning();
  if (!revision) throw new Error('Revision insert returned no row');
  if (signatories.length) await tx.insert(documentRevisionSignatoriesTable).values(signatories.map((snapshot) => ({ ...snapshot, revisionId: revision.id })));
  for (let offset = 0; offset < financial.length; offset += 500) {
    await tx.insert(documentFinancialValuesTable).values(financial.slice(offset, offset + 500).map((value) => ({ ...value, revisionId: revision.id })));
  }
  return revision;
}

function audit(tx: Tx, actor: string, documentId: string, action: string, revision: Revision, note?: string | null) {
  return tx.insert(activityLogsTable).values({ actorUserId: actor, entityType: 'document', entityId: documentId, action,
    metadata: { revisionId: revision.id, revisionNumber: revision.revisionNumber, templateVersionId: revision.templateVersionId,
      ...(note != null && { changeNote: note }) } });
}

export async function createDocument(db: Db, actor: string, input: CreateInput) {
  return db.transaction(async (tx) => {
    const [selected] = await tx.select({ templateId: documentTemplatesTable.id, typeId: documentTypesTable.id,
      templateActive: documentTemplatesTable.isActive, typeActive: documentTypesTable.isActive, code: documentTypesTable.code,
    }).from(templateVersionsTable).innerJoin(documentTemplatesTable, eq(documentTemplatesTable.id, templateVersionsTable.templateId))
      .innerJoin(documentTypesTable, eq(documentTypesTable.id, documentTemplatesTable.documentTypeId))
      .where(and(eq(templateVersionsTable.id, input.templateVersionId), isNotNull(templateVersionsTable.contentDigest)))
      .for('share', { of: [documentTemplatesTable, documentTypesTable] });
    if (!selected) throw new DocumentError(404, 'Published template version not found');
    if (!hasGrant(await userGrants(tx, actor), 'documents.create', selected.typeId)) throw new DocumentError(403, 'Permission denied');
    const [latest] = await tx.select({ id: templateVersionsTable.id }).from(templateVersionsTable)
      .where(and(eq(templateVersionsTable.templateId, selected.templateId), isNotNull(templateVersionsTable.contentDigest)))
      .orderBy(desc(templateVersionsTable.versionNumber)).limit(1);
    if (!selected.templateActive || !selected.typeActive || latest?.id !== input.templateVersionId.toLowerCase()) {
      throw new DocumentError(409, 'Select the current version of an active template');
    }
    const template = await loadPublishedTemplateVersion(tx, latest.id);
    if (!template || template.renderSnapshot.code !== selected.code) throw new DocumentError(409, 'Template version is unavailable');
    if (input.managingOfficeId) {
      const [office] = await tx.select({ id: officesTable.id }).from(officesTable).where(eq(officesTable.id, input.managingOfficeId));
      if (!office) throw new DocumentValidationError('Managing office must exist');
    }
    const draft = await prepareDraft(tx, template, input, input.fiscalYear ?? null);
    const [document] = await tx.insert(documentsTable).values({ templateId: selected.templateId, createdBy: actor,
      title: input.title, description: input.description, managingOfficeId: input.managingOfficeId, fiscalYear: input.fiscalYear,
      referenceNumber: input.referenceNumber }).returning();
    if (!document) throw new Error('Document insert returned no row');
    const revision = await appendRevision(tx, { documentId: document.id, templateVersionId: template.id, revisionNumber: 1,
      values: draft.values, createdBy: actor, changeNote: input.changeNote }, draft.signatories, draft.financial);
    await audit(tx, actor, document.id, 'document.created', revision, input.changeNote);
    return { ...document, documentTypeId: selected.typeId, documentTypeCode: selected.code, currentRevision: revision.revisionNumber };
  });
}

const changePermissions = { revise: 'documents.revise', finalize: 'documents.finalize', archive: 'documents.archive' } as const;

export async function changeDocument(db: Db, actor: string, documentId: string, input: ChangeInput) {
  return db.transaction(async (tx) => {
    const [record] = await tx.select({ document: documentsTable, typeId: documentTemplatesTable.documentTypeId,
      code: documentTypesTable.code }).from(documentsTable)
      .innerJoin(documentTemplatesTable, eq(documentTemplatesTable.id, documentsTable.templateId))
      .innerJoin(documentTypesTable, eq(documentTypesTable.id, documentTemplatesTable.documentTypeId))
      .where(eq(documentsTable.id, documentId)).for('update', { of: documentsTable });
    if (!record) notFound();
    const { document, typeId } = record;
    const permission = changePermissions[input.operation];
    const grants = await userGrants(tx, actor);
    if (!hasGrant(grants, permission, typeId)) {
      if (!hasGrant(grants, 'documents.read', typeId)) notFound();
      throw new DocumentError(403, 'Permission denied');
    }
    const [current] = await tx.select().from(documentRevisionsTable).where(eq(documentRevisionsTable.documentId, document.id))
      .orderBy(desc(documentRevisionsTable.revisionNumber)).limit(1);
    if (!current || current.revisionNumber !== input.expectedRevision) throw new DocumentError(409, 'Expected revision no longer matches');
    if (!permitsDocumentStatus(permission, document.status) || current.status !== document.status) {
      throw new DocumentError(409, 'Document lifecycle does not allow this operation');
    }
    const [initial] = await tx.select({ templateVersionId: documentRevisionsTable.templateVersionId }).from(documentRevisionsTable)
      .where(eq(documentRevisionsTable.documentId, document.id)).orderBy(asc(documentRevisionsTable.revisionNumber)).limit(1);
    if (initial?.templateVersionId !== current.templateVersionId) throw new DocumentError(409, 'Document history has inconsistent template versions');
    const template = await loadPublishedTemplateVersion(tx, initial.templateVersionId);
    if (!template || template.templateId !== document.templateId || template.renderSnapshot.code !== record.code) {
      throw new DocumentError(409, 'Pinned template version is unavailable');
    }

    let revision = current;
    let status: Document['status'] = 'archived';
    if (input.operation !== 'archive') {
      if (current.revisionNumber === 2_147_483_647) throw new DocumentError(409, 'Revision limit reached');
      const draft = input.operation === 'revise' ? await prepareDraft(tx, template, input, document.fiscalYear, current.id) : {
        values: validateDocumentValues(template.fieldSchema, current.values),
        signatories: await revisionSignatories(tx, current.id),
        financial: await tx.select(financialColumns).from(documentFinancialValuesTable)
          .where(eq(documentFinancialValuesTable.revisionId, current.id)),
      };
      status = input.operation === 'revise' ? 'draft' : 'finalized';
      revision = await appendRevision(tx, { documentId: document.id, templateVersionId: template.id,
        revisionNumber: current.revisionNumber + 1, values: draft.values, status, createdBy: actor, changeNote: input.changeNote },
      draft.signatories, draft.financial);
    }
    const [updated] = await tx.update(documentsTable).set({ status }).where(eq(documentsTable.id, document.id)).returning();
    if (!updated) throw new Error('Document status update returned no row');
    const action = { revise: 'document.revised', finalize: 'document.finalized', archive: 'document.archived' }[input.operation];
    await audit(tx, actor, document.id, action, revision, input.changeNote);
    return { ...updated, documentTypeId: typeId, documentTypeCode: record.code, currentRevision: revision.revisionNumber };
  });
}

function documentMetadata(db: Db) {
  return db.select({ document: documentsTable, documentTypeId: documentTypesTable.id, documentTypeCode: documentTypesTable.code,
    currentRevision: sql<number | null>`(select max(r.revision_number) from document_revisions r where r.document_id = ${documentsTable.id})`,
  }).from(documentsTable).innerJoin(documentTemplatesTable, eq(documentTemplatesTable.id, documentsTable.templateId))
    .innerJoin(documentTypesTable, eq(documentTypesTable.id, documentTemplatesTable.documentTypeId));
}

export async function listDocuments(db: Db, actor: string, after?: string) {
  const grants = (await userGrants(db, actor)).filter(({ name }) => name === 'documents.read');
  if (!grants.length) return [];
  const types = grants.flatMap(({ documentTypeId }) => documentTypeId ? [documentTypeId] : []);
  const rows = await documentMetadata(db).where(and(grants.some(({ documentTypeId }) => documentTypeId === null) ? undefined :
    inArray(documentTypesTable.id, types), after ? gt(documentsTable.id, after) : undefined)).orderBy(asc(documentsTable.id)).limit(50);
  return rows.map(({ document, ...metadata }) => ({ ...document, ...metadata }));
}

export async function readDocument(db: Db, actor: string, documentId: string) {
  const [record] = await documentMetadata(db).where(eq(documentsTable.id, documentId));
  if (!record || !permitsDocumentStatus('documents.read', record.document.status) ||
      !hasGrant(await userGrants(db, actor), 'documents.read', record.documentTypeId)) notFound();
  const { document, ...metadata } = record;
  return { ...document, ...metadata };
}

const revisionMetadata = {
  id: documentRevisionsTable.id, documentId: documentRevisionsTable.documentId, templateVersionId: documentRevisionsTable.templateVersionId,
  revisionNumber: documentRevisionsTable.revisionNumber, status: documentRevisionsTable.status,
  changeNote: documentRevisionsTable.changeNote, createdBy: documentRevisionsTable.createdBy, createdAt: documentRevisionsTable.createdAt,
};

export async function listRevisions(db: Db, actor: string, documentId: string, afterRevision: number) {
  const document = await readDocument(db, actor, documentId);
  return db.select(revisionMetadata).from(documentRevisionsTable).innerJoin(templateVersionsTable,
    eq(templateVersionsTable.id, documentRevisionsTable.templateVersionId)).where(and(eq(documentRevisionsTable.documentId, document.id),
    eq(templateVersionsTable.templateId, document.templateId), gt(documentRevisionsTable.revisionNumber, afterRevision)))
    .orderBy(asc(documentRevisionsTable.revisionNumber)).limit(50);
}

export async function findDocumentRevision(db: Db, document: { id: string; templateId: string }, number: number) {
  const [revision] = await db.select({ ...revisionMetadata, values: documentRevisionsTable.values }).from(documentRevisionsTable)
    .innerJoin(templateVersionsTable, eq(templateVersionsTable.id, documentRevisionsTable.templateVersionId))
    .where(and(eq(documentRevisionsTable.documentId, document.id), eq(documentRevisionsTable.revisionNumber, number),
      eq(templateVersionsTable.templateId, document.templateId)));
  if (!revision) throw new DocumentError(404, 'Revision not found');
  return revision;
}

export async function readRevision(db: Db, actor: string, documentId: string, number: number) {
  const document = await readDocument(db, actor, documentId);
  const revision = await findDocumentRevision(db, document, number);
  return { ...revision, signatories: await revisionSignatories(db, revision.id) };
}
