import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDatabase } from '/app/dist/db/client.js';
import {
  documentsTable, documentRevisionsTable, documentTemplatesTable, documentTypesTable, templateVersionsTable, usersTable,
} from '/app/dist/db/schema.js';
import { publishTemplate } from '/app/dist/templates/publication.js';
import { readPublication, snapshotDigest } from '/app/dist/templates/snapshot.js';

assert.match(process.env.DATABASE_URL, /^postgresql:\/\/ebdrms_fixture:[a-f0-9]+@db:5432\/ebdrms_ops_fixture$/);
const database = createDatabase(process.env.DATABASE_URL);
try {
  const [{ id: actor }] = await database.db.insert(usersTable)
    .values({ fullName: 'Backup fixture', email: 'backup@example.test', passwordHash: 'fixture-only' }).returning();
  const latest = await readPublication('CAFOA');
  const [{ id: type }] = await database.db.insert(documentTypesTable).values({ code: 'CAFOA', name: 'CAFOA' }).returning();
  const [{ id: template }] = await database.db.insert(documentTemplatesTable)
    .values({ documentTypeId: type, resourceKey: '/templates/cafoa', name: 'CAFOA' }).returning();
  const original = structuredClone(latest);
  original.templateSource = original.templateSource.replace('</body>', '<p>Historical release</p></body>');
  const historicalLogo = original.renderSnapshot.assets.municipalLogo;
  assert.ok(historicalLogo);
  // A valid fixture PNG different from the current repository logo.
  historicalLogo.base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5J8AAAAASUVORK5CYII=';
  historicalLogo.sha256 = createHash('sha256').update(Buffer.from(historicalLogo.base64, 'base64')).digest('hex');
  assert.notEqual(historicalLogo.sha256, latest.renderSnapshot.assets.municipalLogo.sha256);
  const digest = snapshotDigest(original);
  const [{ id: version }] = await database.db.insert(templateVersionsTable)
    .values({ ...original, templateId: template, versionNumber: 1, contentDigest: digest, createdBy: actor }).returning();
  const [{ id: document }] = await database.db.insert(documentsTable)
    .values({ title: 'Backup fixture', templateId: template, createdBy: actor }).returning();
  await database.db.insert(documentRevisionsTable)
    .values({ documentId: document, revisionNumber: 1, templateVersionId: version, createdBy: actor, values: {} });
  const publication = await publishTemplate(database.db, 'CAFOA', actor, snapshotDigest(latest));
  assert.equal(publication.templateId, template);
  assert.equal(publication.versionNumber, 2);
  console.log(digest);
} finally {
  await database.close();
}
