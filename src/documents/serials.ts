import { eq, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { documentRevisionsTable, documentSerialCountersTable as counters } from '../db/schema.js';
import { findFund } from '../reference-data/service.js';
import { DocumentValidationError } from '../templates/validation.js';

type Db = Database['db'];
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

const maxSequence = 9999;
const municipalDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit' });
export const fundCodePattern = '^[0-9]{3}$';
export const isFundCode = (code: string) => new RegExp(fundCodePattern).test(code);

// Must run in the same transaction that issues the document and saves its revision.
export async function allocateDocumentSerial(tx: Transaction, fundCode: string, issuedAt = new Date()) {
  if (!isFundCode(fundCode) || !await findFund(tx, fundCode)) {
    throw new DocumentValidationError('Select a registered three-digit fund code');
  }
  const parts = municipalDate.formatToParts(issuedAt);
  const year = Number(parts.find(({ type }) => type === 'year')?.value);
  const month = parts.find(({ type }) => type === 'month')?.value;
  if (!month || !Number.isInteger(year) || year < 1 || year > 9999) throw new Error('Invalid document issuance date');
  const yearSuffix = String(year).padStart(4, '0').slice(-2);

  const [existing] = await tx.select({ year: counters.year }).from(counters).where(eq(counters.year, year));
  let first = 1;
  if (!existing) {
    // Reserve recognizable old serials without modifying their saved snapshots.
    const pattern = `^[0-9]{4}-(0[1-9]|1[0-2])-${yearSuffix}-[0-9]{3}$`;
    const savedSerial = sql`${documentRevisionsTable.values} ->> 'serialNumber'`;
    const [legacy] = await tx.select({ highest: sql<number>`coalesce(max(left(${savedSerial}, 4)::integer), 0)` })
      .from(documentRevisionsTable).where(sql`(${savedSerial}) ~ ${pattern}`);
    first += legacy?.highest ?? 0;
  }
  if (first > maxSequence) return undefined;
  const [allocated] = await tx.insert(counters).values({ year, lastValue: first }).onConflictDoUpdate({
    target: counters.year,
    set: { lastValue: sql`${counters.lastValue} + 1` },
    setWhere: lt(counters.lastValue, maxSequence),
  }).returning({ sequence: counters.lastValue });
  if (!allocated) return undefined;
  return `${String(allocated.sequence).padStart(4, '0')}-${month}-${yearSuffix}-${fundCode}`;
}
