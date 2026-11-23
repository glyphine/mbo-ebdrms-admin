import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sql } from '/app/node_modules/drizzle-orm/index.js';
import { createApp } from '/app/dist/app.js';
import { loadConfig } from '/app/dist/config.js';
import { loadPublishedTemplateVersion } from '/app/dist/templates/publication.js';

const url = process.env.DATABASE_URL;
assert.equal(url, 'postgresql://postgres@127.0.0.1:5432/ebdrms_restore_test');
const app = createApp(loadConfig({
  DATABASE_URL: url, NODE_ENV: 'test', AUTH_JWT_ACTIVE_KID: 'drill',
  AUTH_JWT_KEYS: JSON.stringify({ drill: randomBytes(32).toString('base64url') }),
}));
try {
  for (const path of ['/health/live', '/health/ready']) {
    assert.equal((await app.inject(path)).statusCode, 200, path);
  }
  const { rows: [revision] } = await app.db.execute(sql`
    SELECT r.template_version_id, r.values, t.render_snapshot->>'code' AS code,
      EXISTS (
        SELECT 1 FROM template_versions newer WHERE newer.template_id = t.template_id
          AND newer.version_number > t.version_number AND newer.content_digest IS NOT NULL
      ) AS superseded
    FROM document_revisions r JOIN template_versions t ON t.id = r.template_version_id
    WHERE t.content_digest IS NOT NULL
    ORDER BY superseded DESC, (t.render_snapshot->>'code' = 'CAFOA') DESC, r.created_at
    LIMIT 1
  `);
  if (!revision) {
    console.log('PDF restore check skipped: no revisions reference a published snapshot');
  } else {
    const content = await loadPublishedTemplateVersion(app.db, revision.template_version_id);
    assert.ok(content, 'Restored revision must have its pinned snapshot');
    const pdf = await app.pdfRenderer.render(async () => ({ content, contentDigest: content.contentDigest, values: revision.values }));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    if (revision.code === 'CAFOA') {
      assert.match(pdf.toString('latin1'), /\/Subtype\s*\/Image\b/, 'CAFOA PDF must contain the embedded logo');
    }
    console.log(`PDF restored code=${revision.code} superseded=${revision.superseded} template_digest=${content.contentDigest}`);
  }
} finally {
  await app.close();
}
