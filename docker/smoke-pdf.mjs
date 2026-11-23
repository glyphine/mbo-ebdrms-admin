import assert from 'node:assert/strict';
import { templateCodes } from '/app/dist/templates/contracts.js';
import { readPublication, snapshotDigest } from '/app/dist/templates/snapshot.js';
import { PdfRenderer } from '/app/dist/pdf/renderer.js';

assert.equal(process.cwd(), '/tmp');
assert.notEqual(process.getuid(), 0);
const renderer = new PdfRenderer();
try {
  for (const code of templateCodes) {
    const content = await readPublication(code);
    const pdf = await renderer.render(async () => ({ content, contentDigest: snapshotDigest(content), values: {} }));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', code);
  }
  const report = await renderer.renderReport({
    sourceTitle: 'Container smoke test', revisionNumber: 1, finalizedAt: '2026-01-01T00:00:00Z',
    fiscalYear: 'Fiscal year 2026', period: 'Coverage dates unavailable', periodMatched: true,
    filters: [], metrics: [], snapshotId: '0'.repeat(64), groupBy: 'Office',
    breakdown: { items: [], totalGroups: 0 }, omittedGroups: 0, charts: [],
  });
  assert.equal(report.subarray(0, 5).toString(), '%PDF-');
  process.stdout.write('Rendered all six document types and the dashboard PDF from packaged resources\n');
} finally {
  await renderer.close();
}
