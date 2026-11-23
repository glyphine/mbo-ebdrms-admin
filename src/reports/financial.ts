import { createHash } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { documentFinancialValuesTable as financial, documentRevisionsTable as revisions, documentsTable as documents,
  documentTemplatesTable as templates, officesTable as offices, templateVersionsTable as versions } from '../db/schema.js';
import { hasGrant, userGrants } from '../rbac/permissions.js';
import { loadPublishedTemplateVersion } from '../templates/publication.js';
import { documentRegistry } from '../templates/registry.js';

export const financialMetrics = {
  appropriations: 'Appropriations', allotment: 'Allotments', obligation: 'Obligations',
  appropriationBalance: 'Appropriation balance', balance: 'Allotment balance',
} as const;
export type Metric = keyof typeof financialMetrics;
export const metricKeys = Object.keys(financialMetrics) as Metric[];
export const dimensions = ['office', 'category', 'officeCategory'] as const;
type Dimension = typeof dimensions[number];
type Db = Database['db'];
type ReadDb = Pick<Db, 'select'>;
type Amounts = Partial<Record<Metric, bigint>>;
type Office = { id: string | null; label: string };

export interface FinancialQuery {
  sourceDocumentId: string;
  fiscalYear?: number;
  fromDate?: string;
  toDate?: string;
  officeIds?: (string | null)[];
  categories?: (string | null)[];
  metrics?: Metric[];
  groupBy?: Dimension;
  limit?: number;
  offset?: number;
}

export class ReportError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 422, message: string) { super(message); }
}

const revisionLimit = 10_000; // The currently published office/category bounds permit at most 9,600 metric groups.
const eligibleStatus = sql`${documents.status} in ('finalized','archived')`;

async function authorizedTemplate(db: ReadDb, actor: string, exporting: boolean) {
  const grants = await userGrants(db, actor);
  if (!hasGrant(grants, 'reports.read') || (exporting && !hasGrant(grants, 'reports.export'))) {
    throw new ReportError(403, 'Permission denied');
  }
  const [template] = await db.select({ id: templates.id, typeId: templates.documentTypeId }).from(templates)
    .where(eq(templates.resourceKey, documentRegistry.SAAOB.resourceKey));
  return template && hasGrant(grants, 'documents.read', template.typeId) ? template.id : undefined;
}

function eligibleSources(db: ReadDb) {
  // The current head must itself be finalized. Do not fall back to an earlier finalized revision.
  return db.select({ documentId: documents.id, title: documents.title, fiscalYear: documents.fiscalYear,
    revisionId: revisions.id, revisionNumber: revisions.revisionNumber, templateVersionId: revisions.templateVersionId,
    finalizedAt: revisions.createdAt, from: sql<string | null>`${revisions.values}->>'startDate'`,
    through: sql<string | null>`${revisions.values}->>'endDate'`,
  }).from(documents).innerJoin(revisions, eq(revisions.id, sql`(select r.id from document_revisions r
    where r.document_id = ${documents.id} order by r.revision_number desc limit 1)`))
    .innerJoin(versions, eq(versions.id, revisions.templateVersionId));
}

function eligibility(templateId: string) {
  return and(eq(documents.templateId, templateId), eligibleStatus, eq(revisions.status, 'finalized'),
    eq(versions.templateId, documents.templateId), isNotNull(versions.contentDigest),
    sql`${versions.renderSnapshot}->>'code' = 'SAAOB'`);
}

function isoDate(value: string | null) {
  if (!value || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

type SourceRow = Awaited<ReturnType<typeof eligibleSources>>[number];
function sourceMetadata({ from, through, fiscalYear, ...source }: SourceRow) {
  const fromDate = isoDate(from);
  const toDate = isoDate(through);
  const knownDates = fromDate && toDate && fromDate <= toDate;
  return { ...source, finalizedAt: source.finalizedAt.toISOString(),
    period: { fiscalYear, fromDate: knownDates ? fromDate : null, toDate: knownDates ? toDate : null } };
}

export async function listFinancialSources(db: Db, actor: string, query: { fiscalYear?: number; after?: string; limit: number }) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '4s'`);
    const templateId = await authorizedTemplate(tx, actor, false);
    if (!templateId) return { items: [], nextAfter: null };
    const rows = await eligibleSources(tx).where(and(eligibility(templateId), query.after ? gt(documents.id, query.after) : undefined,
      query.fiscalYear === undefined ? undefined : eq(documents.fiscalYear, query.fiscalYear)))
      .orderBy(asc(documents.id)).limit(query.limit + 1);
    const items = rows.slice(0, query.limit).map(sourceMetadata);
    return { items, nextAfter: rows.length > query.limit ? items.at(-1)!.documentId : null };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

const categoryLabel = sql<string | null>`nullif(btrim(${revisions.values} #>> array['offices',
  substring(${financial.fieldPath} from '^offices[[]([0-9]+)[]]'), 'categories',
  substring(${financial.fieldPath} from '[.]categories[[]([0-9]+)[]]'), 'name']), '')`;

function groupedFinancialRows(db: ReadDb, source: SourceRow, metrics: Metric[]) {
  return db.select({ officeId: financial.officeId, officeName: offices.name, officeCode: offices.code,
    category: categoryLabel, metric: financial.metricKey, amount: sql<string>`sum(${financial.amount})::text`,
  }).from(financial).innerJoin(revisions, eq(revisions.id, financial.revisionId))
    .leftJoin(offices, eq(offices.id, financial.officeId))
    .where(and(eq(financial.revisionId, source.revisionId), eq(financial.isAggregate, false), inArray(financial.metricKey, metrics),
      sql`${financial.fiscalYear} is not distinct from ${source.fiscalYear}::integer`,
      sql`${financial.fieldPath} ~ '^offices[[][0-9]+[]][.]categories[[][0-9]+[]][.]entries[[][0-9]+[]][.][A-Za-z]+$'`,
      sql`right(${financial.fieldPath}, length(${financial.metricKey}) + 1) = '.' || ${financial.metricKey}`))
    .groupBy(financial.officeId, offices.name, offices.code, categoryLabel, financial.metricKey).limit(revisionLimit + 1);
}

export function decimalCents(value: string) {
  // PostgreSQL returns sums of numeric(18,2) with scale 2, possibly wider than a single entry.
  return BigInt(value.replace('.', ''));
}

function decimalString(value: bigint | undefined) {
  if (value === undefined) return null;
  const unsigned = (value < 0n ? -value : value).toString().padStart(3, '0');
  return `${value < 0n ? '-' : ''}${unsigned.slice(0, -2)}.${unsigned.slice(-2)}`;
}

function add(target: Amounts, metric: Metric, amount: bigint) {
  target[metric] = (target[metric] ?? 0n) + amount;
}

const compareText = (left: string, right: string) => left.localeCompare(right, 'en') || (left < right ? -1 : left > right ? 1 : 0);
const byLabel = (a: { label: string; key: string }, b: { label: string; key: string }) =>
  compareText(a.label, b.label) || compareText(a.key, b.key);

export function queryFinancialReport(db: Db, actor: string, query: FinancialQuery, exporting = false) {
  if (query.fromDate && query.toDate && query.fromDate > query.toDate) throw new ReportError(400, 'Invalid date range');
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '4s'`);
    const templateId = await authorizedTemplate(tx, actor, exporting);
    if (!templateId) throw new ReportError(404, 'Financial source not found');
    const [row] = await eligibleSources(tx).where(and(eligibility(templateId), eq(documents.id, query.sourceDocumentId)));
    if (!row) throw new ReportError(404, 'Financial source not found');
    const version = await loadPublishedTemplateVersion(tx, row.templateVersionId);
    if (!version || version.renderSnapshot.code !== 'SAAOB') throw new ReportError(409, 'Financial source version is unavailable');
    const source = sourceMetadata(row);
    const { fiscalYear, fromDate, toDate } = source.period;
    if ((query.fromDate || query.toDate) && (!fromDate || !toDate)) {
      throw new ReportError(422, 'The source has no complete ISO date coverage');
    }
    const periodMatched = (query.fiscalYear === undefined || query.fiscalYear === fiscalYear) &&
      (!query.fromDate || (fromDate !== null && query.fromDate <= fromDate)) &&
      (!query.toDate || (toDate !== null && toDate <= query.toDate));
    const metrics = query.metrics ?? metricKeys;
    const groupBy = query.groupBy ?? 'office';
    const officeIds = query.officeIds?.map((id) => id?.toLowerCase() ?? null) ?? [];
    const categories = query.categories?.map((category) => category?.trim() || null) ?? [];
    const rows = periodMatched ? await groupedFinancialRows(tx, row, metrics) : [];
    if (rows.length > revisionLimit) throw new ReportError(422, 'Source exceeds the breakdown limit');

    const totals: Amounts = {};
    const groups = new Map<string, { key: string; label: string; office: Office | null; category: string | null; sums: Amounts }>();
    const availableOffices = new Map<string | null, Office>();
    const availableCategories = new Set<string | null>();
    for (const { officeId, officeCode, officeName, category, metric, amount } of rows) {
      const office = { id: officeId, label: officeName ? `${officeName} (${officeCode})` : 'Unassigned office' };
      availableOffices.set(officeId, office);
      availableCategories.add(category);
      if ((officeIds.length && !officeIds.includes(officeId)) || (categories.length && !categories.includes(category))) continue;
      const bucketOffice = groupBy === 'category' ? null : office;
      const bucketCategory = groupBy === 'office' ? null : category;
      const key = JSON.stringify([bucketOffice?.id ?? null, bucketCategory]);
      let group = groups.get(key);
      if (!group) {
        const labels = groupBy === 'office' ? [office.label] : [category ?? 'Uncategorized'];
        if (groupBy === 'officeCategory') labels.unshift(office.label);
        group = { key, label: labels.join(' / '), office: bucketOffice, category: bucketCategory, sums: {} };
        groups.set(key, group);
      }
      const cents = decimalCents(amount);
      add(group.sums, metric as Metric, cents);
      add(totals, metric as Metric, cents);
    }
    const amounts = (sums: Amounts) => metrics.map((metric) => ({ metric, amount: decimalString(sums[metric]) }));
    const breakdown = [...groups.values()].sort(byLabel).map(({ sums, ...group }) => ({ ...group, values: amounts(sums) }));
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 25;
    const view = {
      source, periodMatched, filters: { fiscalYear: query.fiscalYear ?? null, fromDate: query.fromDate ?? null,
        toDate: query.toDate ?? null, officeIds, categories },
      facets: { offices: [...availableOffices.values()].sort((a, b) => compareText(a.label, b.label) || compareText(a.id ?? '', b.id ?? '')),
        categories: [...availableCategories].sort((a, b) => compareText(a ?? '', b ?? '')) },
      metrics: amounts(totals).map((metric) => ({ ...metric, label: financialMetrics[metric.metric] })),
      breakdown: { groupBy, totalGroups: breakdown.length, items: breakdown.slice(offset, offset + limit),
        nextOffset: offset + limit < breakdown.length ? offset + limit : null },
      chart: { groupBy, points: breakdown.slice(0, 12).map(({ key, label, values }) => ({ key, label, values })),
        omittedGroups: Math.max(0, breakdown.length - 12) },
    };
    return { ...view, snapshotId: createHash('sha256').update(JSON.stringify(view)).digest('hex') };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

export type FinancialReport = Awaited<ReturnType<typeof queryFinancialReport>>;
