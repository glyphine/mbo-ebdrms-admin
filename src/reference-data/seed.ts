import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { documentTypesTable, expenditureClassificationsTable, fundsTable, officesTable } from '../db/schema.js';
import { templateCodes } from '../templates/contracts.js';
import { documentRegistry } from '../templates/registry.js';
import { baselineExpenditureClassifications, baselineFunds, municipalOffices } from './magpet.js';
import { findFund, findOfficesByCodes, listExpenditureClassifications, listFunds } from './service.js';

type Reference = { code: string; name: string; kind?: string; parentOfficeId?: string | null };
type Difference = { code: string; field: string; expected: string | null; actual: string | null };
function summarize(expected: Reference[], actual: Reference[], inserted: { code: string }[], linked: string[] = []) {
  const insertedCodes = new Set(inserted.map(({ code }) => code));
  const changed = new Set([...insertedCodes, ...linked]);
  const unchanged: string[] = [];
  const conflicts: Difference[] = [];
  const keys = ['name', 'kind', 'parentOfficeId'] as const;
  for (const row of expected) {
    const saved = actual.find(({ code }) => code === row.code);
    if (!saved) throw new Error('Seed record disappeared during verification');
    const differences = keys.filter((key) => row[key] !== undefined && row[key] !== saved[key]);
    for (const key of differences) {
      conflicts.push({ code: row.code, field: key, expected: row[key] ?? null, actual: saved[key] ?? null });
    }
    if (!differences.length && !changed.has(row.code)) unchanged.push(row.code);
  }
  return { inserted: expected.filter(({ code }) => insertedCodes.has(code)).map(({ code }) => code), linked, unchanged, conflicts };
}

export function seedReferenceData(db: Database['db']) {
  return db.transaction(async (tx) => {
    const offices = municipalOffices.filter(({ parentCode }) => parentCode === null)
      .map(({ code, name }) => ({ code, name, parentOfficeId: null }));
    const insertedOffices = await tx.insert(officesTable).values(offices)
      .onConflictDoNothing({ target: officesTable.code }).returning({ code: officesTable.code });
    const [mayor] = await findOfficesByCodes(tx, ['1011']);
    if (!mayor) throw new Error('Mayor office reference is unavailable');
    const subdivisions = municipalOffices.filter(({ parentCode }) => parentCode === mayor.code)
      .map(({ code, name }) => ({ code, name, parentOfficeId: mayor.id }));
    insertedOffices.push(...await tx.insert(officesTable).values(subdivisions)
      .onConflictDoNothing({ target: officesTable.code }).returning({ code: officesTable.code }));

    const linked: string[] = [];
    for (const { code, name, parentOfficeId } of subdivisions) {
      const [filled] = await tx.update(officesTable).set({ parentOfficeId })
        .where(and(eq(officesTable.code, code), eq(officesTable.name, name), isNull(officesTable.parentOfficeId)))
        .returning({ code: officesTable.code });
      if (filled) linked.push(filled.code);
    }
    const officeResult = summarize([...offices, ...subdivisions],
      await findOfficesByCodes(tx, municipalOffices.map(({ code }) => code)), insertedOffices, linked);
    const [existingSpa] = await findOfficesByCodes(tx, ['SPA']);
    if (existingSpa) officeResult.conflicts.push({ code: 'SPA', field: 'office record', expected: null, actual: existingSpa.name });

    const insertedFunds = await tx.insert(fundsTable).values(baselineFunds)
      .onConflictDoNothing({ target: fundsTable.code }).returning({ code: fundsTable.code });
    const classifications = await tx.insert(expenditureClassificationsTable).values([...baselineExpenditureClassifications])
      .onConflictDoNothing({ target: expenditureClassificationsTable.code }).returning({ code: expenditureClassificationsTable.code });
    const types = templateCodes.map((code) => ({ code, name: documentRegistry[code].name }));
    const insertedTypes = await tx.insert(documentTypesTable).values(types)
      .onConflictDoNothing({ target: documentTypesTable.code }).returning({ code: documentTypesTable.code });
    const storedTypes = await tx.select().from(documentTypesTable).where(inArray(documentTypesTable.code, [...templateCodes]));

    return {
      offices: officeResult,
      funds: summarize(baselineFunds, await listFunds(tx), insertedFunds),
      expenditureClassifications: summarize([...baselineExpenditureClassifications], await listExpenditureClassifications(tx), classifications),
      documentTypes: summarize(types, storedTypes, insertedTypes),
      warnings: [(await findFund(tx, '101') ? 'Existing fund 101 preserved. ' : '') +
        'Confirm workbook fund 101 with the Municipal Budget Office before using it for new serials. No alias was applied.'],
    };
  });
}
