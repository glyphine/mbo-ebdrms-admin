import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { activityLogsTable, authLogsTable, authSessionsTable, documentRevisionsTable, documentTemplatesTable,
  officesTable, permissionsTable, roleDocumentTypePermissionsTable, rolePermissionsTable, rolesTable, userRolesTable,
  usersTable } from '../src/db/schema.js';
import { approveDevice, requestDeviceEnrollment } from '../src/devices/service.js';
import { changeDocument, createDocument } from '../src/documents/service.js';
import { publishTemplate } from '../src/templates/publication.js';
import { readPublication, snapshotDigest } from '../src/templates/snapshot.js';
import { readPdf, runChromiumTests } from './helpers/pdf.js';

const testDatabase = process.env['DEVICE_TEST_DATABASE_URL'];
test('financial dashboard, PDF and audit share authorized and exact reporting data', {
  skip: !testDatabase && 'Set DEVICE_TEST_DATABASE_URL to a disposable PostgreSQL database',
}, async (t) => {
  assert.ok(testDatabase);
  const coordinator = createDatabase(testDatabase);
  const schema = `reports_test_${randomUUID().replaceAll('-', '')}`;
  await coordinator.db.execute(sql`create schema ${sql.identifier(schema)}`);
  const url = new URL(testDatabase);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const database = createDatabase(url.toString());
  const { db } = database;
  const key = Buffer.alloc(32, 25);
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

  const [operator, viewer, outsider, auditor] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await db.insert(usersTable).values([operator, viewer, outsider, auditor].map((id) => ({
    id, email: `${id}@example.test`, fullName: 'Fixture', passwordHash: 'fixture-only',
  })));
  const [officeA, officeB] = [randomUUID(), randomUUID()];
  await db.insert(officesTable).values([{ id: officeA, code: '0101', name: 'Budget Office' }, { id: officeB, code: '0202', name: 'Health Office' }]);
  const published = async (code: 'SAAOB' | 'RAAOPS') => publishTemplate(db, code, operator, snapshotDigest(await readPublication(code)));
  const saaob = await published('SAAOB');
  const raao = await published('RAAOPS');
  const permissions = await db.insert(permissionsTable).values([
    'documents.read', 'documents.create', 'documents.revise', 'documents.finalize', 'documents.archive',
    'reports.read', 'reports.export', 'audit.read',
  ].map((name) => ({ name }))).returning();
  async function assign(userId: string, global: string[], templateIds: string[], scoped: string[]) {
    const [role] = await db.insert(rolesTable).values({ name: userId }).returning();
    assert.ok(role);
    await db.insert(userRolesTable).values({ userId, roleId: role.id });
    await db.insert(rolePermissionsTable).values(permissions.filter(({ name }) => global.includes(name))
      .map(({ id }) => ({ roleId: role.id, permissionId: id })));
    for (const templateId of templateIds) {
      const [template] = await db.select().from(documentTemplatesTable).where(eq(documentTemplatesTable.id, templateId));
      assert.ok(template);
      await db.insert(roleDocumentTypePermissionsTable).values(permissions.filter(({ name }) => scoped.includes(name))
        .map(({ id }) => ({ roleId: role.id, documentTypeId: template.documentTypeId, permissionId: id })));
    }
  }
  await assign(operator, ['reports.read', 'reports.export'], [saaob.templateId, raao.templateId],
    ['documents.read', 'documents.create', 'documents.revise', 'documents.finalize', 'documents.archive']);
  await assign(viewer, ['reports.read'], [saaob.templateId], ['documents.read']);
  await assign(outsider, ['reports.read'], [raao.templateId], ['documents.read']);
  await assign(auditor, ['audit.read'], [], []);

  async function session(userId: string) {
    const device = await requestDeviceEnrollment(db, userId, 'Fixture');
    assert.ok(await approveDevice(db, operator, { userId, deviceId: device.deviceId }));
    const id = randomUUID();
    await db.insert(authSessionsTable).values({ id, userId, deviceId: device.deviceId, expiresAt: sql`now() + interval '1 hour'` });
    return { id, token: app.jwt.sign({ sub: userId, did: device.deviceId, sid: id, jti: randomUUID() }, { key }) };
  }
  const [{ token: writer }, { token: reader, id: readerSession }, { token: other }, { token: audit }] = await Promise.all([
    session(operator), session(viewer), session(outsider), session(auditor),
  ]);
  const call = (method: 'GET' | 'POST', url: string, token?: string, payload?: object) => app.inject({ method, url,
    ...(token && { headers: { authorization: `Bearer ${token}` } }), ...(payload && { payload }) });
  const base = '/api/v1/reports/financial';
  const sources = `${base}/sources`;
  const auditUrl = '/api/v1/audit/events';
  const january = { startDate: '2026-01-01', endDate: '2026-01-31' };
  const alternate = { offices: [{ code: '0101', categories: [{ name: 'MOOE', entries: [{ appropriations: '99.00' }] }] }] };
  const values = { ...january, offices: [
    { code: '0101', categories: [{ name: 'MOOE', entries: [{ appropriations: '9007199254740993.10', allotment: '0.20', obligation: '0.10' }] },
      { name: 'Personal Services', entries: [{ appropriations: '0.30', allotment: '0.00' }] }] },
    { code: '0202', categories: [{ name: 'MOOE', entries: [{ appropriations: '0.20', allotment: '0.20', obligation: '0.30' }] }] },
    { name: 'Unassigned', categories: [{ entries: [{ appropriations: '0.10' }] }] },
  ] };
  const primary = await createDocument(db, operator, { templateVersionId: saaob.id,
    managingOfficeId: officeB, fiscalYear: 2026, title: 'January snapshot <script>fixture</script>', values: { ...january, ...alternate } });
  await changeDocument(db, operator, primary.id, { operation: 'revise', expectedRevision: 1, values });
  await changeDocument(db, operator, primary.id, { operation: 'finalize', expectedRevision: 2 });
  await changeDocument(db, operator, primary.id, { operation: 'archive', expectedRevision: 3 });
  const [head] = await db.select().from(documentRevisionsTable).where(and(eq(documentRevisionsTable.documentId, primary.id),
    eq(documentRevisionsTable.revisionNumber, 3)));
  assert.ok(head);
  const overlap = await createDocument(db, operator, { templateVersionId: saaob.id, fiscalYear: 2026, title: 'Overlapping snapshot',
    values: { ...january, ...alternate } });
  await changeDocument(db, operator, overlap.id, { operation: 'finalize', expectedRevision: 1 });
  const missingDates = await createDocument(db, operator, { templateVersionId: saaob.id, title: 'Legacy coverage labels',
    values: { startDate: 'January 1', endDate: 'January 31', ...alternate } });
  await changeDocument(db, operator, missingDates.id, { operation: 'finalize', expectedRevision: 1 });
  const stale = await createDocument(db, operator, { templateVersionId: saaob.id, fiscalYear: 2026, title: 'Inconsistent head', values });
  await changeDocument(db, operator, stale.id, { operation: 'finalize', expectedRevision: 1 });
  await db.insert(documentRevisionsTable).values({ documentId: stale.id, templateVersionId: saaob.id, createdBy: operator,
    revisionNumber: 3, status: 'draft', values: {} });
  const draft = await createDocument(db, operator, { templateVersionId: saaob.id, fiscalYear: 2026, title: 'Draft only', values });
  const different = await createDocument(db, operator, { templateVersionId: raao.id, fiscalYear: 2026, title: 'RAAO',
    values: { budgetRows: [{ appropriationAmount: '500000.00', details: ['500000.00'] }] } });
  await changeDocument(db, operator, different.id, { operation: 'finalize', expectedRevision: 1 });

  assert.equal((await call('GET', sources)).statusCode, 401);
  assert.equal((await call('GET', sources, audit)).statusCode, 403);
  assert.deepEqual((await call('GET', sources, other)).json().items, []);
  const list = await call('GET', `${sources}?fiscalYear=2026&limit=1`, reader);
  assert.equal(list.statusCode, 200, list.body);
  const next = await call('GET', `${sources}?fiscalYear=2026&limit=1&after=${list.json().nextAfter}`, reader);
  assert.deepEqual([list.json().items[0].documentId, next.json().items[0].documentId].sort(), [primary.id, overlap.id].sort());
  assert.equal(next.json().nextAfter, null);
  for (const doc of [draft, stale, different]) assert.equal((await call('POST', base, writer, { sourceDocumentId: doc.id })).statusCode, 404);
  assert.equal((await call('POST', base, other, { sourceDocumentId: primary.id })).statusCode, 404);
  assert.equal((await call('POST', base, reader, { sourceDocumentId: primary.id, html: '<div>test</div>' })).statusCode, 400);
  assert.equal((await call('POST', base, reader, { sourceDocumentId: primary.id, metrics: ['appropriations', 'appropriations'] })).statusCode, 400);
  assert.equal((await call('POST', base, reader, { sourceDocumentId: primary.id, fromDate: '2026-02-01', toDate: '2026-01-01' })).statusCode, 400);
  const noDates = await call('POST', base, reader, { sourceDocumentId: missingDates.id });
  assert.deepEqual(noDates.json().source.period, { fiscalYear: null, fromDate: null, toDate: null });
  assert.equal((await call('POST', base, reader, { sourceDocumentId: missingDates.id, fromDate: '2026-01-01' })).statusCode, 422);

  const all = await call('POST', base, reader, { sourceDocumentId: primary.id, groupBy: 'category', limit: 1 });
  assert.equal(all.statusCode, 200, all.body);
  assert.equal(all.json().source.revisionId, head.id);
  assert.deepEqual(all.json().source.period, { fiscalYear: 2026, fromDate: '2026-01-01', toDate: '2026-01-31' });
  const amount = (data: { metrics: { metric: string; amount: string | null }[] }, metric: string) =>
    data.metrics.find((row) => row.metric === metric)?.amount;
  assert.equal(amount(all.json(), 'appropriations'), '9007199254740993.70');
  assert.equal(amount(all.json(), 'allotment'), '0.40');
  assert.equal(amount(all.json(), 'obligation'), '0.40');
  assert.equal(amount(all.json(), 'balance'), '0.00');
  assert.equal(all.json().breakdown.items.length, 1);
  assert.equal(all.json().breakdown.totalGroups, 3);
  assert.equal(all.json().breakdown.nextOffset, 1);
  assert.equal(all.json().chart.points.length, 3);
  const mooe = all.json().chart.points.find(({ label }: { label: string }) => label === 'MOOE');
  assert.equal(amount({ metrics: mooe.values }, 'appropriations'), '9007199254740993.30');
  const unassigned = await call('POST', base, reader, { sourceDocumentId: primary.id, officeIds: [null], categories: [null] });
  assert.equal(amount(unassigned.json(), 'appropriations'), '0.10');
  assert.equal(amount(unassigned.json(), 'obligation'), null);
  for (const filter of [{ fiscalYear: 2025 }, { fromDate: '2026-01-02' }, { toDate: '2026-01-30' }]) {
    const excluded = await call('POST', base, reader, { sourceDocumentId: primary.id, ...filter });
    assert.equal(excluded.json().periodMatched, false);
    assert.equal(amount(excluded.json(), 'appropriations'), null);
  }

  const selection = { sourceDocumentId: primary.id, fiscalYear: 2026, fromDate: '2026-01-01', toDate: '2026-01-31',
    officeIds: [officeA], categories: ['MOOE'], metrics: ['appropriations', 'balance'], groupBy: 'officeCategory' };
  const selected = await call('POST', base, reader, selection);
  assert.equal(selected.statusCode, 200, selected.body);
  const snapshot = selected.json().snapshotId as string;
  assert.equal(amount(selected.json(), 'appropriations'), '9007199254740993.10');
  assert.equal(amount(selected.json(), 'balance'), '0.10');
  assert.equal(selected.json().chart.points[0].label, 'Budget Office (0101) / MOOE');
  assert.equal((await call('POST', `${base}/pdf`, reader, selection)).statusCode, 403);
  assert.equal((await call('POST', `${base}/pdf`, writer, { ...selection, templateSource: '<%= x %>' })).statusCode, 400);
  if (runChromiumTests) {
    const pdf = await call('POST', `${base}/pdf`, writer, { ...selection, expectedSnapshotId: snapshot });
    assert.equal(pdf.statusCode, 200, pdf.body.slice(0, 100));
    assert.equal(pdf.headers['x-report-snapshot'], snapshot);
    assert.equal(pdf.headers['cache-control'], 'private, no-store');
    assert.match(String(pdf.headers['content-disposition']), /^attachment; filename="financial-report-/);
    const text = readPdf('pdftotext', ['-', '-'], pdf.rawPayload).replace(/\s+/g, ' ');
    for (const expected of ['Financial dashboard snapshot', '2026-01-01 to 2026-01-31', 'Selected filters',
      'Budget Office (0101)', 'MOOE', 'Appropriations', '9007199254740993.10', 'Charts by Office and category', snapshot]) {
      assert.ok(text.includes(expected), `PDF missing ${expected}: ${text}`);
    }
    assert.doesNotMatch(text, /STATEMENT OF APPROPRIATION|Health Office/);
  }
  await db.update(officesTable).set({ name: 'Renamed Budget Office' }).where(eq(officesTable.id, officeA));
  assert.equal((await call('POST', `${base}/pdf`, writer, { ...selection, expectedSnapshotId: snapshot })).statusCode, 409);

  assert.equal((await call('GET', auditUrl, reader)).statusCode, 403);
  assert.equal((await call('POST', auditUrl, audit, {})).statusCode, 404);
  const reportAudit = await call('GET', `${auditUrl}?targetType=financial_report&targetId=${primary.id}`, audit);
  assert.equal(reportAudit.statusCode, 200, reportAudit.body);
  assert.ok(reportAudit.json().items.some(({ action, actorUserId }: { action: string; actorUserId: string }) =>
    action === 'report.financial_viewed' && actorUserId === viewer));
  if (runChromiumTests) assert.ok(reportAudit.json().items.some(({ action, actorUserId }: { action: string; actorUserId: string }) =>
    action === 'report.financial_pdf_exported' && actorUserId === operator));
  const events = await db.select().from(activityLogsTable).where(and(eq(activityLogsTable.entityId, primary.id),
    eq(activityLogsTable.action, 'report.financial_viewed')));
  assert.ok(events.some((event) => event.metadata?.['snapshotId'] === snapshot && event.metadata?.['revisionId'] === head.id));
  assert.doesNotMatch(reportAudit.body, /metadata|message|password/);

  assert.equal((await call('POST', '/api/v1/auth/logout', reader)).statusCode, 204);
  const [loggedOut] = await db.select().from(authLogsTable).where(eq(authLogsTable.action, 'auth.logout'));
  assert.equal(loggedOut?.targetId, readerSession);
  await db.execute(sql`insert into auth_logs (user_id, action, created_at) values
    (${viewer}, 'auth.login_denied', '2026-01-15T00:00:00.123457Z'), (${viewer}, 'auth.login_denied', '2026-01-15T00:00:00.123456Z')`);
  const authPage = `${auditUrl}?stream=authentication&limit=1&action=auth.login_denied&fromDate=2026-01-15&toDate=2026-01-15`;
  const one = await call('GET', authPage, audit);
  assert.equal(one.statusCode, 200, one.body);
  assert.equal(one.json().items[0].timestamp, '2026-01-15T00:00:00.123457Z');
  assert.equal(one.json().items[0].actorUserId, null);
  assert.equal(one.json().items[0].targetId, viewer);
  const two = await call('GET', `${authPage}&after=${one.json().nextAfter}`, audit);
  assert.equal(two.json().items[0].timestamp, '2026-01-15T00:00:00.123456Z');
  assert.equal(two.json().nextAfter, null);
  assert.equal((await call('GET', `${auditUrl}?after=${one.json().nextAfter}`, audit)).statusCode, 400);
  const loggedOutAudit = await call('GET', `${auditUrl}?stream=authentication&action=auth.logout&actorUserId=${viewer}`, audit);
  assert.equal(loggedOutAudit.json().items[0].actorUserId, viewer);
  assert.equal(loggedOutAudit.json().items[0].targetId, readerSession);
  const auditReads = await db.select().from(activityLogsTable).where(eq(activityLogsTable.action, 'audit.events_viewed'));
  assert.equal(auditReads.length, 4);
  assert.ok(auditReads.every((event) => event.actorUserId === auditor && event.entityType === 'audit_stream'));
  assert.equal((await call('POST', base, reader, selection)).statusCode, 401);
});
