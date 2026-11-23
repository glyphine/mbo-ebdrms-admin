import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from '../src/db/client.js';
import {
  documentsTable, documentRevisionsTable, documentSerialCountersTable, documentTemplatesTable, documentTypesTable,
  fundsTable, officesTable, usersTable,
} from '../src/db/schema.js';
import { allocateDocumentSerial } from '../src/documents/serials.js';
import { seedReferenceData } from '../src/reference-data/seed.js';
import { findFund, findOfficesByCodes, listExpenditureClassifications, listFunds } from '../src/reference-data/service.js';
import { templateCodes } from '../src/templates/contracts.js';
import { loadPublishedTemplateVersion, publishTemplate } from '../src/templates/publication.js';
import { readPublication, snapshotDigest } from '../src/templates/snapshot.js';

const testDatabase = process.env['DEVICE_TEST_DATABASE_URL'];
test('Magpet reference seeding preserves existing data and serials reserve the annual series', {
  skip: !testDatabase && 'Set DEVICE_TEST_DATABASE_URL to a disposable PostgreSQL database',
}, async (t) => {
  assert.ok(testDatabase);
  const coordinator = createDatabase(testDatabase);
  const schema = `references_test_${randomUUID().replaceAll('-', '')}`;
  await coordinator.db.execute(sql`create schema ${sql.identifier(schema)}`);
  const url = new URL(testDatabase);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const database = createDatabase(url.toString());
  const { db } = database;
  t.after(async () => {
    try {
      await database.close();
      await coordinator.db.execute(sql`drop schema ${sql.identifier(schema)} cascade`);
    } finally {
      await coordinator.close();
    }
  });
  await migrate(db, { migrationsFolder: 'drizzle', migrationsSchema: schema });

  const [existingOffice] = await db.insert(officesTable).values({ code: '1071', name: 'Manually corrected budget office' }).returning();
  assert.ok(existingOffice);
  await db.insert(officesTable).values([
    { code: '1011 (1)', name: 'OMM – Tourism Unit' },
    { code: '1011 (2)', name: 'OMM – Market Operations Unit', parentOfficeId: existingOffice.id },
  ]);
  await db.insert(fundsTable).values([{ code: '101', name: 'Existing workbook fund' }, { code: '200', name: 'Existing fund label' }]);
  const [actor] = await db.insert(usersTable).values({ email: 'seed-test@example.test', fullName: 'Fixture', passwordHash: 'fixture' }).returning();
  assert.ok(actor);
  const publication = await publishTemplate(db, 'RAAOPS', actor.id, snapshotDigest(await readPublication('RAAOPS')));
  const historicalTemplate = await loadPublishedTemplateVersion(db, publication.id);
  const [legacy] = await db.insert(documentsTable).values({
    templateId: publication.templateId, title: 'Historical fixture', createdBy: actor.id, status: 'finalized',
  }).returning();
  assert.ok(legacy);
  const legacyValues = { fund: '101', serialNumber: '0003-01-27-101' };
  await db.insert(documentRevisionsTable).values({
    documentId: legacy.id, templateVersionId: publication.id, revisionNumber: 1, createdBy: actor.id, status: 'finalized', values: legacyValues,
  });

  const first = await seedReferenceData(db);
  assert.equal(first.offices.inserted.length, 21);
  assert.deepEqual(first.offices.linked, ['1011 (1)']);
  assert.deepEqual(first.offices.conflicts.map(({ code, field }) => [code, field]), [['1071', 'name'], ['1011 (2)', 'parentOfficeId']]);
  assert.deepEqual(first.funds.inserted, ['100', '300']);
  assert.deepEqual(first.funds.conflicts, [{ code: '200', field: 'name', expected: 'Special Education Fund', actual: 'Existing fund label' }]);
  assert.deepEqual(first.documentTypes.unchanged, ['RAAOPS']);
  assert.equal(first.expenditureClassifications.inserted.length, 5);
  assert.match(first.warnings.join(' '), /Existing fund 101 preserved/);

  const reruns = await Promise.all([seedReferenceData(db), seedReferenceData(db)]);
  for (const rerun of reruns) {
    for (const result of [rerun.offices, rerun.funds, rerun.expenditureClassifications, rerun.documentTypes]) {
      assert.deepEqual(result.inserted, []);
      assert.deepEqual(result.linked, []);
    }
    assert.deepEqual(rerun.offices.conflicts, first.offices.conflicts);
    assert.equal(rerun.offices.unchanged.length, 22);
  }

  const offices = await findOfficesByCodes(db, ['1011', '1011 (1)', '1011 (2)', '1011 (3)', '1011 (4)', '1011 (5)', '1071', '1011(1)', 'SPA']);
  const byCode = new Map(offices.map((office) => [office.code, office]));
  const parent = byCode.get('1011')!;
  assert.equal(parent.name, 'Office of the Municipal Mayor (OMM)');
  assert.equal(await db.$count(officesTable), 24);
  for (const code of ['1011 (1)', '1011 (3)', '1011 (4)', '1011 (5)']) assert.equal(byCode.get(code)?.parentOfficeId, parent.id);
  assert.equal(byCode.get('1011 (2)')?.parentOfficeId, existingOffice.id);
  assert.equal(byCode.get('1071')?.name, existingOffice.name);
  assert.equal(byCode.has('1011(1)'), false);
  assert.equal(byCode.has('SPA'), false);
  await assert.rejects(db.insert(officesTable).values({ code: '1011 (1)', name: 'Duplicate' }), /Failed query/);
  const classifications = await listExpenditureClassifications(db);
  assert.deepEqual(classifications.filter(({ kind }) => kind === 'class').map(({ code }) => code), ['CO', 'FE', 'MOOE', 'PS']);
  assert.deepEqual(classifications.find(({ code }) => code === 'SPA'), { code: 'SPA', name: 'Special Purpose Appropriations', kind: 'grouping' });
  assert.deepEqual((await listFunds(db)).map(({ code }) => code), ['100', '101', '200', '300']);
  assert.deepEqual(await findFund(db, '100'), { code: '100', name: 'General Fund' });
  assert.deepEqual(await findFund(db, '101'), { code: '101', name: 'Existing workbook fund' });
  assert.deepEqual((await db.select({ code: documentTypesTable.code }).from(documentTypesTable)).map(({ code }) => code).sort(), [...templateCodes].sort());
  assert.equal(await db.$count(documentTemplatesTable), 1);
  assert.deepEqual(await loadPublishedTemplateVersion(db, publication.id), historicalTemplate);
  const [preserved] = await db.select().from(documentRevisionsTable).where(eq(documentRevisionsTable.documentId, legacy.id));
  assert.deepEqual(preserved?.values, legacyValues);
  assert.equal((await db.select().from(documentsTable).where(eq(documentsTable.id, legacy.id)))[0]?.serialNumber, null);

  const allocate = (fund: string, date: string) => db.transaction((tx) => allocateDocumentSerial(tx, fund, new Date(date)));
  await assert.rejects(allocate('999', '2026-12-31T16:00:00Z'), /registered/);
  assert.equal(await allocate('100', '2026-12-31T15:59:59Z'), '0001-12-26-100');
  const january = await Promise.all(['100', '200', '300', '100'].map((code) => allocate(code, '2026-12-31T16:00:00Z')));
  assert.deepEqual(january.map((serial) => serial?.slice(0, 4)).sort(), ['0004', '0005', '0006', '0007']);
  assert.ok(january.every((serial) => /^000[4-7]-01-27-(100|200|300)$/.test(serial ?? '')));
  assert.equal(await allocate('200', '2027-02-01T00:00:00Z'), '0008-02-27-200');
  await assert.rejects(db.transaction(async (tx) => {
    await allocateDocumentSerial(tx, '100', new Date('2027-02-01T00:00:00Z'));
    throw new Error('roll back the allocation');
  }), /roll back/);
  assert.equal(await allocate('100', '2027-02-01T00:00:00Z'), '0009-02-27-100');
  await db.update(documentSerialCountersTable).set({ lastValue: 9998 }).where(eq(documentSerialCountersTable.year, 2027));
  assert.equal(await allocate('100', '2027-12-01T00:00:00Z'), '9999-12-27-100');
  assert.equal(await allocate('100', '2027-12-01T00:00:00Z'), undefined);
  assert.equal(await allocate('100', '2028-01-01T00:00:00Z'), '0001-01-28-100');

  const issuedIdentity = { templateId: publication.templateId, title: 'Constraint fixture', createdBy: actor.id, status: 'finalized' as const,
    serialNumber: '0001-01-28-100', serialFundCode: '100' };
  await db.insert(documentsTable).values(issuedIdentity);
  await assert.rejects(db.insert(documentsTable).values(issuedIdentity), /Failed query/);
  for (const bad of [
    { serialNumber: '001-01-28-100' }, { serialNumber: '0002-13-28-100' }, { serialNumber: '0002-01-28-200' },
    { serialNumber: '0002-01-28-999', serialFundCode: '999' },
  ]) await assert.rejects(db.insert(documentsTable).values({ ...issuedIdentity, ...bad }), /Failed query/);
});
