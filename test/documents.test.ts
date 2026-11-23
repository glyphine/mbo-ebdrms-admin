import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { activityLogsTable, authSessionsTable, documentFinancialValuesTable, documentRevisionsTable,
  documentRevisionSignatoriesTable, documentsTable, documentTemplatesTable, officesTable, permissionsTable,
  roleDocumentTypePermissionsTable, rolesTable, signatoriesTable, userRolesTable, usersTable } from '../src/db/schema.js';
import { approveDevice, requestDeviceEnrollment } from '../src/devices/service.js';
import { deriveFinancialValues, projectFinancialValues } from '../src/documents/financials.js';
import type { TemplateCode } from '../src/templates/contracts.js';
import { publishTemplate } from '../src/templates/publication.js';
import { documentRegistry } from '../src/templates/registry.js';
import { readPublication, snapshotDigest } from '../src/templates/snapshot.js';
import { validateDocumentValues } from '../src/templates/validation.js';
import { readPdf, runChromiumTests } from './helpers/pdf.js';

test('financial derivation preserves print rows and uses exact cents', () => {
  const cafoa = documentRegistry.CAFOA.fields;
  const certificate = validateDocumentValues(cafoa, {
    details: [{ expenseCode: '001', amount: '0.1' }, null, { amount: '0.20' }],
    ledgers: [{ obligation: '0.30' }, null, { liquidations: '0.1' }], approvedAmount: '0.30',
  });
  const aggregates = deriveFinancialValues('CAFOA', certificate);
  assert.deepEqual(certificate['amount'], '0.30');
  assert.match(String(certificate['amountWords']), /thirty centavos/);
  assert.deepEqual(certificate['ledgers'], [{ obligation: '0.30', balance: '0.30' }, null, { liquidations: '0.1', balance: '0.20' }]);
  const projections = projectFinancialValues(cafoa, certificate, aggregates, new Map());
  assert.equal(projections.find(({ fieldPath }) => fieldPath === 'details[0].amount')?.accountCode, '001');
  assert.equal(projections.find(({ fieldPath }) => fieldPath === 'ledgers[2].balance')?.isAggregate, true);
  const registry = validateDocumentValues(documentRegistry.RAAOPS.fields, { actualRows: [null, { details: [null, '0.10', '-0.1'] }], budgetRows: null });
  deriveFinancialValues('RAAOPS', registry);
  assert.deepEqual(registry, { actualRows: [null, { details: [null, '0.10', '-0.1'], totalAmount: '0.00' }], budgetRows: null });
  const tooLarge = validateDocumentValues(cafoa, { details: [{ amount: '9999999999999999.99' }, { amount: '0.01' }] });
  assert.throws(() => deriveFinancialValues('CAFOA', tooLarge), /exceeds numeric/);
});

const testDatabase = process.env['DEVICE_TEST_DATABASE_URL'];
test('document API preserves authorized, pinned history across edits, finalization, and archive', {
  skip: !testDatabase && 'Set DEVICE_TEST_DATABASE_URL to a disposable PostgreSQL database',
}, async (t) => {
  assert.ok(testDatabase);
  // Use an isolated migrated schema so concurrent requests can commit on separate connections.
  const coordinator = createDatabase(testDatabase);
  const schema = `documents_test_${randomUUID().replaceAll('-', '')}`;
  await coordinator.db.execute(sql`create schema ${sql.identifier(schema)}`);
  const url = new URL(testDatabase);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const database = createDatabase(url.toString());
  const { db } = database;
  const key = Buffer.alloc(32, 24);
  const app = createApp(loadConfig({ NODE_ENV: 'test', DATABASE_URL: url.toString(), AUTH_JWT_ACTIVE_KID: 'test',
    AUTH_JWT_KEYS: JSON.stringify({ test: key.toString('base64url') }) }), { database });
  t.after(async () => {
    try {
      await app.close();
      await coordinator.db.execute(sql`drop schema ${sql.identifier(schema)} cascade`);
    } finally {
      await coordinator.close();
    }
  });
  await migrate(db, { migrationsFolder: 'drizzle', migrationsSchema: schema });
  await app.ready();

  const [writer, reviewer, outsider] = [randomUUID(), randomUUID(), randomUUID()];
  const [managingOffice, reportingOffice, signatoryId] = [randomUUID(), randomUUID(), randomUUID()];
  await db.insert(officesTable).values([
    { id: managingOffice, code: 'MBO', name: 'Managing office' }, { id: reportingOffice, code: '0101', name: 'Reporting office' },
  ]);
  await db.insert(usersTable).values([writer, reviewer, outsider].map((id) => ({ id, email: `${id}@example.test`, fullName: 'Fixture',
    officeId: managingOffice, passwordHash: 'fixture-only' })));
  await db.insert(signatoriesTable).values({ id: signatoryId, fullName: 'Original Name', designation: 'Budget officer' });
  async function publish(code: TemplateCode, directory?: string) {
    return publishTemplate(db, code, writer, snapshotDigest(await readPublication(code, directory)), directory);
  }
  const original = await publish('SAAOB');
  const cafoa = await publish('CAFOA');
  const raao = await publish('RAAOPS');
  const actions = ['documents.create', 'documents.read', 'documents.revise', 'documents.finalize', 'documents.archive', 'documents.export'];
  const permissions = await db.insert(permissionsTable).values(actions.map((name) => ({ name }))).returning();
  async function grant(userId: string, templateIds: string[], names: string[]) {
    const [role] = await db.insert(rolesTable).values({ name: userId }).returning();
    assert.ok(role);
    await db.insert(userRolesTable).values({ userId, roleId: role.id });
    for (const templateId of templateIds) {
      const [template] = await db.select().from(documentTemplatesTable).where(eq(documentTemplatesTable.id, templateId));
      assert.ok(template);
      await db.insert(roleDocumentTypePermissionsTable).values(permissions.filter(({ name }) => names.includes(name))
        .map(({ id }) => ({ roleId: role.id, documentTypeId: template.documentTypeId, permissionId: id })));
    }
  }
  await grant(writer, [original.templateId, cafoa.templateId, raao.templateId], [...actions.slice(0, 3), 'documents.export']);
  await grant(reviewer, [original.templateId], ['documents.read', 'documents.finalize', 'documents.archive']);

  async function access(userId: string) {
    const device = await requestDeviceEnrollment(db, userId, 'Fixture');
    assert.ok(await approveDevice(db, writer, { userId, deviceId: device.deviceId }));
    const id = randomUUID();
    await db.insert(authSessionsTable).values({ id, userId, deviceId: device.deviceId, expiresAt: sql`now() + interval '1 hour'` });
    return app.jwt.sign({ sub: userId, did: device.deviceId, sid: id, jti: randomUUID() }, { key });
  }
  const [writerToken, reviewerToken, outsiderToken] = await Promise.all([access(writer), access(reviewer), access(outsider)]);
  const base = '/api/v1/documents';
  const get = (path: string, token = writerToken) => app.inject({ url: base + path, headers: { authorization: `Bearer ${token}` } });
  const post = (path: string, payload: object, token = writerToken) => app.inject({ method: 'POST', url: base + path, payload,
    headers: { authorization: `Bearer ${token}` } });
  const values = { startDate: 'October 1', offices: [{ code: '0101', name: '<b>Office</b>', categories: [
    { name: 'Operations', entries: [{ accountCode: '001', appropriations: '1000000000000000.10', allotment: '0.30', obligation: '0.20' },
      { accountCode: '002', appropriations: '0.20', allotment: '0.20', obligation: '0.10' }] },
  ] }, { name: 'Optional office', categories: null }] };
  const input = { templateVersionId: original.id, title: 'Statement', values, managingOfficeId: managingOffice, fiscalYear: 2026,
    signatories: [{ slotKey: 'preparedBy', signatoryId }] };
  assert.equal((await app.inject(base)).statusCode, 401);
  assert.equal((await post('', input, reviewerToken)).statusCode, 403);
  for (const invalid of [
    { ...input, templateSource: '<%~ it %>' }, { ...input, pdfOptions: {} }, { ...input, resource: '../saaob' },
    { ...input, values: { ...values, grandTotals: null } }, { ...input, values: { ...values, preparedByName: 'Forged' } },
    { ...input, values: { offices: [{ categories: [{ entries: [{ balance: '1.00' }] }] }] } },
    { ...input, values: { offices: [{ code: 'unknown' }] } },
    { ...input, signatories: [{ slotKey: 'preparedBy', signatoryId: writer }] },
  ]) assert.equal((await post('', invalid)).statusCode, 400);
  assert.deepEqual((await get('')).json(), []);

  const created = await post('', input);
  assert.equal(created.statusCode, 201, created.body);
  const { id } = created.json<{ id: string }>();
  assert.equal(created.json().createdBy, writer);
  assert.equal(created.json().managingOfficeId, managingOffice);
  assert.equal(created.json().currentRevision, 1);
  const versionOne = await get(`/${id}/revisions/1`);
  assert.equal(versionOne.statusCode, 200, versionOne.body);
  assert.equal(versionOne.json().values.grandTotals.appropriations, '1000000000000000.30');
  assert.equal(versionOne.json().values.offices[0].categories[0].totals.balance, '0.20');
  assert.equal(versionOne.json().values.offices[1].categories, null);
  assert.equal(versionOne.json().values.preparedByName, 'Original Name');
  const originalRevisionId = versionOne.json().id as string;
  const [projection] = await db.select().from(documentFinancialValuesTable).where(and(
    eq(documentFinancialValuesTable.revisionId, originalRevisionId),
    eq(documentFinancialValuesTable.fieldPath, 'offices[0].categories[0].entries[0].appropriations')));
  assert.equal(projection?.officeId, reportingOffice);
  assert.equal(projection?.accountCode, '001');
  assert.equal(projection?.fiscalYear, 2026);
  assert.equal(projection?.amount, '1000000000000000.10');
  const financialRows = await db.select().from(documentFinancialValuesTable).where(eq(documentFinancialValuesTable.revisionId, originalRevisionId));
  assert.equal(financialRows.find(({ fieldPath }) => fieldPath === 'grandTotals.appropriations')?.isAggregate, true);

  const r = await post('', { templateVersionId: raao.id, title: 'RAAO', values: { actualRows: [null, { details: [null, '10.00'] }] } });
  const c = await post('', { templateVersionId: cafoa.id, title: 'CAFOA', values: { details: [null, { amount: '1.00' }] },
    signatories: [{ slotKey: 'official', signatoryId, date: '2026-10-01' }] });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(c.statusCode, 201, c.body);
  assert.deepEqual((await get(`/${r.json().id}/revisions/1`)).json().values.actualRows, [null, { details: [null, '10.00'], totalAmount: '10.00' }]);
  assert.equal((await get(`/${c.json().id}/revisions/1`)).json().values.officialDate, '2026-10-01');
  assert.deepEqual((await get('', reviewerToken)).json().map((document: { id: string }) => document.id), [id]);
  assert.equal((await get(`/${r.json().id}`, reviewerToken)).statusCode, 404);
  assert.equal((await get(`/${id}`, outsiderToken)).statusCode, 404);
  assert.equal((await get(`/${id}/revisions/1`, outsiderToken)).statusCode, 404);
  assert.equal((await post(`/${id}/revisions`, { expectedRevision: 1, values }, reviewerToken)).statusCode, 403);
  assert.equal((await post(`/${id}/archive`, { expectedRevision: 1 }, reviewerToken)).statusCode, 409);

  const directory = await mkdtemp(join(tmpdir(), 'ebdrms-revision-'));
  t.after(() => rm(directory, { recursive: true }));
  await cp(fileURLToPath(new URL('../templates/', import.meta.url)), directory, { recursive: true });
  const layoutPath = join(directory, 'saaob.eta');
  await writeFile(layoutPath, (await readFile(layoutPath, 'utf8')).replace('</header>', '<p>New reviewed print edition</p></header>'));
  const newer = await publish('SAAOB', directory);
  assert.notEqual(newer.id, original.id);
  assert.equal((await post('', input)).statusCode, 409);
  await db.update(signatoriesTable).set({ fullName: 'Renamed', isActive: false }).where(eq(signatoriesTable.id, signatoryId));
  const results = await Promise.all(['Attempt A', 'Attempt B'].map((serialNumber) =>
    post(`/${id}/revisions`, { expectedRevision: 1, values: { ...values, serialNumber } })));
  assert.deepEqual(results.map(({ statusCode }) => statusCode).sort(), [201, 409], results.map(({ body }) => body).join('\n'));
  const second = (await get(`/${id}/revisions/2`)).json();
  assert.equal(second.templateVersionId, original.id);
  assert.equal(second.signatories[0].displayName, 'Original Name');
  assert.equal((await post(`/${id}/finalize`, { expectedRevision: 1 }, reviewerToken)).statusCode, 409);
  const finalized = await post(`/${id}/finalize`, { expectedRevision: 2 }, reviewerToken);
  assert.equal(finalized.statusCode, 200, finalized.body);
  assert.equal(finalized.json().status, 'finalized');
  const final = (await get(`/${id}/revisions/3`)).json();
  assert.equal(final.createdBy, reviewer);
  assert.equal(final.templateVersionId, original.id);
  assert.deepEqual(final.signatories, second.signatories);
  assert.deepEqual(final.values, second.values);
  assert.equal((await post(`/${id}/revisions`, { expectedRevision: 3, values })).statusCode, 409);
  const finalRows = await db.select().from(documentFinancialValuesTable).where(eq(documentFinancialValuesTable.revisionId, final.id));
  assert.equal(finalRows.length, financialRows.length);
  assert.equal(finalRows.find(({ fieldPath }) => fieldPath === 'grandTotals.balance')?.amount, '0.20');
  const archived = await post(`/${id}/archive`, { expectedRevision: 3 }, reviewerToken);
  assert.equal(archived.statusCode, 200, archived.body);
  assert.equal(archived.json().status, 'archived');
  assert.deepEqual((await get(`/${id}/revisions`)).json().map(({ status }: { status: string }) => status), ['draft', 'draft', 'finalized']);
  assert.deepEqual((await get(`/${id}/revisions/1`)).json(), versionOne.json());
  assert.equal((await get(`/${id}`)).json().currentRevision, 3);

  const audits = await db.select().from(activityLogsTable).where(eq(activityLogsTable.entityId, id));
  assert.deepEqual(audits.map(({ action }) => action).sort(), ['document.archived', 'document.created', 'document.finalized', 'document.revised']);
  const originalExport = `/${id}/revisions/1/pdf`;
  assert.equal((await get(originalExport, reviewerToken)).statusCode, 403);
  assert.equal((await get(originalExport, outsiderToken)).statusCode, 404);
  if (runChromiumTests) {
    const pdf = await get(originalExport);
    assert.equal(pdf.statusCode, 200, pdf.body.slice(0, 100));
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.headers['cache-control'], 'private, no-store');
    assert.equal(pdf.headers['x-content-type-options'], 'nosniff');
    assert.equal(pdf.headers['content-disposition'], `attachment; filename="SAAOB-${id}-r1.pdf"`);
    const oldText = readPdf('pdftotext', ['-', '-'], pdf.rawPayload);
    assert.doesNotMatch(oldText, /New reviewed print edition/);
    assert.match(oldText, /ORIGINAL NAME/);
    const newDocument = await post('', { templateVersionId: newer.id, title: 'New document', values });
    assert.equal(newDocument.statusCode, 201);
    const newPdf = await get(`/${newDocument.json().id}/revisions/1/pdf`);
    assert.equal(newPdf.statusCode, 200);
    assert.match(readPdf('pdftotext', ['-', '-'], newPdf.rawPayload), /New reviewed print edition/);
    const events = await db.select().from(activityLogsTable).where(and(eq(activityLogsTable.entityId, id),
      eq(activityLogsTable.action, 'document.pdf_exported')));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.metadata?.['templateVersionId'], original.id);
  }
  const immutable = (error: unknown) => error instanceof Error && (error.cause as { code?: string })?.code === '55000';
  await assert.rejects(db.update(documentRevisionsTable).set({ values: {} }).where(eq(documentRevisionsTable.id, originalRevisionId)), immutable);
  await assert.rejects(db.delete(documentRevisionSignatoriesTable).where(eq(documentRevisionSignatoriesTable.revisionId, originalRevisionId)), immutable);
  await assert.rejects(db.delete(documentFinancialValuesTable).where(eq(documentFinancialValuesTable.revisionId, originalRevisionId)), immutable);
  await assert.rejects(db.insert(documentRevisionsTable).values({ documentId: id, templateVersionId: newer.id,
    revisionNumber: 4, values: {}, createdBy: writer }), /Failed query/);
  const beforeFailure = await db.select({ id: documentFinancialValuesTable.id }).from(documentFinancialValuesTable);
  await db.execute(sql`alter table activity_logs add constraint reject_test_creation_audit check (action <> 'document.created') not valid`);
  const interrupted = await post('', { templateVersionId: raao.id, title: 'Interrupted write',
    values: { actualRows: [{ details: ['1.00'] }] } });
  assert.equal(interrupted.statusCode, 500);
  assert.equal((await db.select().from(documentRevisionsTable)).length, runChromiumTests ? 6 : 5);
  const afterFailure = await db.select({ id: documentFinancialValuesTable.id }).from(documentFinancialValuesTable);
  assert.deepEqual(afterFailure.map(({ id }) => id).sort(), beforeFailure.map(({ id }) => id).sort());
  assert.equal((await db.select().from(documentsTable)).length, runChromiumTests ? 4 : 3);
});
