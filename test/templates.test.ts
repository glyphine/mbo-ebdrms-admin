import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { eq, sql, TransactionRollbackError } from 'drizzle-orm';
import { Eta } from 'eta/core';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { activityLogsTable, authSessionsTable, documentRevisionsTable, documentsTable, documentTemplatesTable, permissionsTable,
  roleDocumentTypePermissionsTable, rolesTable, templateVersionsTable, userRolesTable, usersTable } from '../src/db/schema.js';
import { approveDevice, requestDeviceEnrollment } from '../src/devices/service.js';
import { templateCodes } from '../src/templates/contracts.js';
import type { FieldShape } from '../src/templates/contracts.js';
import { loadPublishedTemplateVersion, publishTemplate } from '../src/templates/publication.js';
import { documentRegistry } from '../src/templates/registry.js';
import { prepareTemplateData, readPublication, snapshotDigest } from '../src/templates/snapshot.js';
import { DocumentValidationError, validateDocumentValues } from '../src/templates/validation.js';

const templates = fileURLToPath(new URL('../templates/', import.meta.url));

test('each reviewed form accepts its actual inputs and interpolates text with escaping', async (t) => {
  const unsafeLooking = '<img src=x onerror=alert(1)><%= 2+2 %>';
  const ledger = { details: [{ function: '0101', amount: '1250.00' }, null], ledgers: [null, { date: '2028-02-29', balance: '0' }] };
  const registry = { budgetRows: [null, { totalAmount: '0.00', details: ['0', null, '-250.01'] }], actualRows: [] };
  const statement = { startDate: 'November 1', offices: [{ name: 'Office', code: '01', categories: [
    { name: 'Category', entries: [{ accountCode: '0101', appropriationBalance: '99.90' }], totals: { balance: '99.90' } },
  ], totals: null }], grandTotals: { balance: '99.90' } };
  for (const code of templateCodes) {
    await t.test(code, async () => {
      const content = await readPublication(code);
      const form = code === 'CAFOA' ? ledger : code === 'SAAOB' ? statement : registry;
      const input = { ...form, serialNumber: unsafeLooking };
      assert.deepEqual(validateDocumentValues(content.fieldSchema, input), input);
      assert.equal(content.pdfOptions.landscape, code.startsWith('RAAO'));
      assert.equal(content.pdfOptions.format, 'A4');
      assert.ok(content.renderSnapshot.printCss.includes('print-color-adjust: exact'));
      const eta = new Eta({ autoEscape: true });
      for (const [name, source] of Object.entries(content.renderSnapshot.partials)) eta.loadTemplate(name, source);
      const html = eta.renderString(content.templateSource, prepareTemplateData(content, input));
      assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&lt;%= 2+2 %&gt;'));
      assert.ok(!html.includes(unsafeLooking));
      assert.doesNotMatch(html, /<script\b|https:\/\//);
      if (code.startsWith('RAAO')) assert.match(html, new RegExp(code));
      if (code === 'CAFOA') assert.ok(html.includes('src="data:image/png;base64,'));
    });
  }
});

test('recursive validation enforces exact money, shape, placeholder semantics and document bounds', () => {
  const { CAFOA, RAAOCO, SAAOB } = documentRegistry;
  const cafoa = (input: unknown) => validateDocumentValues(CAFOA.fields, input);
  assert.deepEqual(cafoa({ ledgers: null, details: [null], amount: '-9999999999999999.99' }),
    { ledgers: null, details: [null], amount: '-9999999999999999.99' });
  assert.deepEqual(cafoa({}), {});
  for (const input of [
    null, { html: '<b>x</b>' }, { resource: '../cafoa' }, { logoSrc: 'https://example.test/logo.png' },
    { pdfOptions: {} }, { css: 'body {}' }, { templateSource: '<%~ it.x %>' }, { details: [{ source: 'x' }] },
    JSON.parse('{"__proto__":{}}'), { details: [false] }, { details: Array(201).fill(null) },
    { amount: 0 }, { amount: '0.001' }, { amount: '10000000000000000' }, { amount: '1,200.00' },
    { amount: '1e2' }, { amount: '0.00\n' }, { officialDate: '2025-02-29' },
    { payeeName: 'a'.repeat(161) }, { payeeName: '\0' }, { payeeName: '\ud800' },
  ]) assert.throws(() => cafoa(input), DocumentValidationError);
  assert.deepEqual(validateDocumentValues(RAAOCO.fields, { budgetRows: null, actualRows: [] }), { budgetRows: null, actualRows: [] });
  for (const details of [[{}], ['1,000'], Array(9).fill('0')]) {
    assert.throws(() => validateDocumentValues(RAAOCO.fields, { budgetRows: [{ details }] }), DocumentValidationError);
  }
  for (const input of [{ offices: [null] }, { offices: [{ categories: [{ entries: [null] }] }] }, { grandTotals: { cash: '1' } }]) {
    assert.throws(() => validateDocumentValues(SAAOB.fields, input), DocumentValidationError);
  }
  const entry = { name: 'a'.repeat(160) };
  const offices = Array.from({ length: 16 }, () => ({ categories: [{ entries: Array(150).fill(entry) }] }));
  assert.throws(() => validateDocumentValues(SAAOB.fields, { offices }), /text size limit/);
  const manyEntries = Array.from({ length: 80 }, () => ({ categories: Array(24).fill({ entries: Array(150).fill({}) }) }));
  assert.throws(() => validateDocumentValues(SAAOB.fields, { offices: manyEntries }), /structural bounds/);

  let field: FieldShape = { type: 'text', maxLength: 1 };
  let value: unknown = 'x';
  for (let depth = 0; depth < 13; depth++) {
    field = { type: 'list', maxItems: 1, items: field };
    value = [value];
  }
  assert.throws(() => validateDocumentValues([{ ...field, key: 'nested', label: 'Nested' }], { nested: value }), /structural bounds/);
});

test('review digest covers the schema, styles and shared partial, and publication rejects unvetted resources', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ebdrms-layout-'));
  t.after(() => rm(directory, { recursive: true }));
  await cp(templates, directory, { recursive: true });
  const original = await readPublication('RAAOCO', directory);
  const digest = snapshotDigest(original);
  assert.notEqual(snapshotDigest({ ...original, fieldSchema: [] }), digest);
  assert.notEqual(snapshotDigest({ ...original, pdfOptions: { ...original.pdfOptions, landscape: false } }), digest);
  await appendFile(join(directory, '_raao.eta'), '\n<!-- reviewed layout change -->\n');
  const withNewPartial = snapshotDigest(await readPublication('RAAOCO', directory));
  assert.notEqual(withNewPartial, digest);
  await appendFile(join(directory, 'print/raao.css'), '\n@media print { td { padding: 1px; } }\n');
  assert.notEqual(snapshotDigest(await readPublication('RAAOCO', directory)), withNewPartial);
  await appendFile(join(directory, '_raao.eta'), '\n<%~ it.fund %>\n');
  await assert.rejects(readPublication('RAAOCO', directory), /unsupported resource, script or raw interpolation/);
  await appendFile(join(directory, 'saaob.eta'), '<img src="https://example.test/x">');
  await assert.rejects(readPublication('SAAOB', directory), /unsupported resource/);
  await writeFile(join(directory, 'assets/magpet-logo.png'), 'replaced asset');
  await assert.rejects(readPublication('CAFOA', directory), /approved asset digest/);
});

const testDatabase = process.env['DEVICE_TEST_DATABASE_URL'];
test('publication appends snapshots and metadata routes enforce scope on historical versions', {
  skip: !testDatabase && 'Set DEVICE_TEST_DATABASE_URL to a disposable migrated PostgreSQL database',
}, async (t) => {
  assert.ok(testDatabase);
  const database = createDatabase(testDatabase);
  t.after(database.close);
  const directory = await mkdtemp(join(tmpdir(), 'ebdrms-publish-'));
  t.after(() => rm(directory, { recursive: true }));
  await cp(templates, directory, { recursive: true });

  await assert.rejects(database.db.transaction(async (tx) => {
    const userId = randomUUID();
    await tx.insert(usersTable).values({ id: userId, email: `${userId}@example.test`, fullName: 'Publisher', passwordHash: 'fixture-only' });
    const firstContent = await readPublication('RAAOCO', directory);
    const oldDigest = snapshotDigest(firstContent);
    const first = await publishTemplate(tx, 'RAAOCO', userId, oldDigest, directory);
    assert.equal(first.published, true);
    const retry = await publishTemplate(tx, 'RAAOCO', userId, oldDigest, directory);
    assert.equal(retry.id, first.id);
    assert.equal(retry.published, false);
    const [document] = await tx.insert(documentsTable).values({ templateId: first.templateId, createdBy: userId, title: 'Fixture' }).returning();
    assert.ok(document);
    const [revision] = await tx.insert(documentRevisionsTable).values({ documentId: document.id, templateVersionId: first.id,
      revisionNumber: 1, values: { budgetRows: [null] }, createdBy: userId }).returning();
    assert.ok(revision);

    await appendFile(join(directory, '_raao.eta'), '\n<!-- version two -->\n');
    await assert.rejects(publishTemplate(tx, 'RAAOCO', userId, oldDigest, directory), /differs from the approved digest/);
    const next = await readPublication('RAAOCO', directory);
    const second = await publishTemplate(tx, 'RAAOCO', userId, snapshotDigest(next), directory);
    assert.equal(second.versionNumber, first.versionNumber + 1);
    const historical = await loadPublishedTemplateVersion(tx, revision.templateVersionId);
    assert.equal(historical?.contentDigest, oldDigest);
    assert.deepEqual(historical?.renderSnapshot, firstContent.renderSnapshot);
    assert.notDeepEqual((await loadPublishedTemplateVersion(tx, second.id))?.renderSnapshot, historical?.renderSnapshot);
    await assert.rejects(tx.transaction(async (savepoint) => {
      await savepoint.update(templateVersionsTable).set({ templateSource: 'changed' }).where(eq(templateVersionsTable.id, first.id));
    }), /Failed query/);
    await assert.rejects(tx.transaction(async (savepoint) => {
      await savepoint.delete(templateVersionsTable).where(eq(templateVersionsTable.id, second.id));
    }), /Failed query/);

    const saaob = await readPublication('SAAOB', directory);
    const other = await publishTemplate(tx, 'SAAOB', userId, snapshotDigest(saaob), directory);
    const [legacy] = await tx.insert(templateVersionsTable).values({ templateId: other.templateId, versionNumber: other.versionNumber + 1,
      templateSource: 'unverified', fieldSchema: [], pdfOptions: saaob.pdfOptions, createdBy: userId }).returning();
    assert.ok(legacy);
    assert.equal(await loadPublishedTemplateVersion(tx, legacy.id), undefined);
    const audit = await tx.select().from(activityLogsTable).where(eq(activityLogsTable.actorUserId, userId));
    assert.equal(audit.filter((event) => event.action === 'template.published').length, 3);

    const signingKey = Buffer.alloc(32, 22);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: testDatabase, AUTH_JWT_ACTIVE_KID: 'test',
      AUTH_JWT_KEYS: JSON.stringify({ test: signingKey.toString('base64url') }) });
    // Route requests share the disposable transaction so the append-only fixtures can be rolled back.
    const app = createApp(config, { database: { ...database, db: Object.assign(tx, { $client: database.db.$client }), close: async () => {} } });
    t.after(() => app.close());
    await app.ready();
    const enrolled = await requestDeviceEnrollment(tx, userId, 'Fixture');
    assert.ok(await approveDevice(tx, userId, { userId, deviceId: enrolled.deviceId }));
    const sessionId = randomUUID();
    await tx.insert(authSessionsTable).values({ id: sessionId, userId, deviceId: enrolled.deviceId, expiresAt: sql`now() + interval '1 hour'` });
    const accessToken = app.jwt.sign({ sub: userId, did: enrolled.deviceId, sid: sessionId, jti: randomUUID() }, { key: signingKey });
    const headers = { authorization: `Bearer ${accessToken}` };
    const base = '/api/v1/templates';
    assert.equal((await app.inject(base)).statusCode, 401);
    assert.deepEqual((await app.inject({ url: base, headers })).json(), []);
    const [type] = await tx.select({ id: documentTemplatesTable.documentTypeId }).from(documentTemplatesTable)
      .where(eq(documentTemplatesTable.id, first.templateId));
    assert.ok(type);
    const [role] = await tx.insert(rolesTable).values({ name: `fixture-${userId}` }).returning();
    assert.ok(role);
    const [permission] = await tx.insert(permissionsTable).values({ name: 'documents.read' }).onConflictDoUpdate({
      target: permissionsTable.name, set: { name: 'documents.read' },
    }).returning();
    assert.ok(permission);
    await tx.insert(userRolesTable).values({ userId, roleId: role.id });
    await tx.insert(roleDocumentTypePermissionsTable).values({ roleId: role.id, documentTypeId: type.id, permissionId: permission.id });
    const listing = await app.inject({ url: base, headers });
    assert.equal(listing.statusCode, 200);
    assert.deepEqual(listing.json().map((item: { versionId: string }) => item.versionId), [second.id]);
    const old = await app.inject({ url: `${base}/${first.templateId}/versions/${first.versionNumber}`, headers });
    assert.equal(old.statusCode, 200);
    assert.deepEqual(old.json().fieldSchema, firstContent.fieldSchema);
    assert.doesNotMatch(old.body, /templateSource|renderSnapshot|<%/);
    assert.equal((await app.inject({ url: `${base}/${other.templateId}/versions/${other.versionNumber}`, headers })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: base, headers, payload: { templateSource: 'fake' } })).statusCode, 404);
    tx.rollback();
  }), TransactionRollbackError);
});
