import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

export const runChromiumTests = process.env['RUN_PDF_TESTS'] === '1';

export function readPdf(tool: 'pdftotext' | 'pdfinfo' | 'pdfimages', args: string[], pdf: Buffer) {
  const result = spawnSync(tool, args, { input: pdf, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
