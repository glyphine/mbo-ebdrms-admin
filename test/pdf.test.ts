import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { PdfRenderError, PdfRenderer } from '../src/pdf/renderer.js';
import type { PdfOptions, TemplateCode } from '../src/templates/contracts.js';
import { readPublication, snapshotDigest } from '../src/templates/snapshot.js';
import type { SnapshotContent } from '../src/templates/snapshot.js';
import { pdfFixtures } from './fixtures/pdf-documents.js';
import { readPdf, runChromiumTests } from './helpers/pdf.js';

const kind = (expected: PdfRenderError['kind']) => (error: unknown) => error instanceof PdfRenderError && error.kind === expected;
const input = (content: SnapshotContent, values: unknown) => ({ content, values, contentDigest: snapshotDigest(content) });
const sandboxedChromium = () => chromium.launch({ chromiumSandbox: true, headless: true, timeout: 8000 });
const chromiumSkip = !runChromiumTests && 'Set RUN_PDF_TESTS=1 with sandboxed Chromium and Poppler installed';

test('renderer rejects missing, altered and oversized inputs before starting Chromium', async (t) => {
  let launches = 0;
  const renderer = new PdfRenderer(async () => { launches++; throw new Error('Browser must stay closed'); });
  t.after(() => renderer.close());
  const cafoa = await readPublication('CAFOA');
  const missing = { ...cafoa, renderSnapshot: { ...cafoa.renderSnapshot, assets: {} } };
  await assert.rejects(renderer.render(async () => input(missing, {})), kind('render'));
  const logo = cafoa.renderSnapshot.assets.municipalLogo!;
  const altered = { ...cafoa, renderSnapshot: { ...cafoa.renderSnapshot, assets: { municipalLogo: { ...logo, sha256: '0'.repeat(64) } } } };
  await assert.rejects(renderer.render(async () => input(altered, {})), kind('render'));
  await assert.rejects(renderer.render(async () => input(cafoa, { logoSrc: 'https://example.test/other.png' })), /unknown field/);
  const statement = await readPublication('SAAOB');
  const category = { name: 'Reporting category', entries: Array.from({ length: 105 }, () => ({ name: 'Entry' })) };
  const offices = Array.from({ length: 10 }, () => ({ name: 'Office', categories: [category] }));
  await assert.rejects(renderer.render(async () => input(statement, { offices })), kind('limit'));
  assert.equal(launches, 0);
});

test('deadline, output limit and print failure close contexts and release capacity', async (t) => {
  let closed = 0;
  let opens = 0;
  const actions = [
    () => new Promise<Buffer>(() => {}),
    async () => Buffer.alloc(12 * 1024 * 1024 + 1),
    async () => { throw new Error('Print pipeline failed'); },
    async () => Buffer.from('%PDF-1.4'),
  ];
  const browser = {
    once() {}, isConnected: () => true, close: async () => {},
    newContext: async () => {
      const pdf = actions[opens++];
      return {
        route: async () => {}, close: async () => { closed++; },
        newPage: async () => ({ pdf, evaluate: async () => {}, setContent: async () => {} }),
      };
    },
  } as unknown as Browser;
  const renderer = new PdfRenderer(async () => browser, 75);
  t.after(() => renderer.close());
  const prepared = input(await readPublication('RAAOCO'), {});
  for (const failure of ['timeout', 'limit', 'render'] as const) {
    await assert.rejects(renderer.render(async () => prepared), kind(failure));
  }
  assert.equal((await renderer.render(async () => prepared)).toString(), '%PDF-1.4');
  assert.equal(closed, 4);
});

test('fixture PDFs preserve all six layouts, paper orientation and the embedded municipal logo', { skip: chromiumSkip }, async (t) => {
  let launches = 0;
  const renderer = new PdfRenderer(async () => { launches++; return sandboxedChromium(); });
  t.after(() => renderer.close());
  const snapshots = new Map<TemplateCode, SnapshotContent>();
  for (const { code, data, label } of pdfFixtures) {
    const content = snapshots.get(code) ?? await readPublication(code);
    snapshots.set(code, content);
    const pdf = await renderer.render(async () => input(content, data));
    assert.match(pdf.subarray(0, 8).toString(), /^%PDF-/);
    const info = readPdf('pdfinfo', ['-'], pdf);
    const paper = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(info);
    assert.ok(paper);
    const landscape = code.startsWith('RAAO');
    assert.equal(Number(paper[1]) > Number(paper[2]), landscape);
    assert.ok(Math.abs(Math.min(Number(paper[1]), Number(paper[2])) - 595) < 2);
    const text = readPdf('pdftotext', ['-layout', '-', '-'], pdf).replace(/\s+/g, ' ');
    assert.ok(text.includes(label), `${code} should include ${label}: ${text}`);
    assert.match(info, /Pages:\s+1\b/, `${code} fixture should fit on one page`);
    if (code === 'CAFOA') {
      assert.match(readPdf('pdfimages', ['-list', '-'], pdf), /\b2048\s+2048\b/);
      assert.match(text, /Subsidiary Ledger/);
    } else if (landscape) {
      assert.ok(text.indexOf('A. Budget') < text.indexOf('B. Actual'));
    }
  }
  assert.equal(launches, 1);
});

test('supported paper sizes and custom margins come from the published options', { skip: chromiumSkip }, async (t) => {
  const renderer = new PdfRenderer();
  t.after(() => renderer.close());
  const source = await readPublication('SAAOB');
  const dimensions: [PdfOptions['format'], number, number][] = [
    ['A3', 842, 1191], ['A5', 420, 595], ['Letter', 612, 792], ['Legal', 612, 1008],
  ];
  for (const [format, width, height] of dimensions) {
    const content = { ...source, pdfOptions: { ...source.pdfOptions, format,
      margin: { top: '25mm', left: '10mm', right: '10mm', bottom: '15mm' } } };
    const pdf = await renderer.render(async () => input(content, { startDate: 'Margin fixture' }));
    const info = readPdf('pdfinfo', ['-'], pdf);
    const paper = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(info);
    assert.ok(paper);
    assert.ok(Math.abs(Number(paper[1]) - width) < 2 && Math.abs(Number(paper[2]) - height) < 2, info);
    const box = /<word xMin="[\d.]+" yMin="([\d.]+)"/.exec(readPdf('pdftotext', ['-bbox', '-', '-'], pdf));
    assert.ok(box && Math.abs(Number(box[1]) - 25 * 72 / 25.4) < 3, '25mm top margin is applied');
  }
});

test('a null print row reserves vertical space in the shared RAAO layout', { skip: chromiumSkip }, async (t) => {
  const renderer = new PdfRenderer();
  t.after(() => renderer.close());
  const content = await readPublication('RAAOCO');
  const first = { particulars: 'FIRSTROW' };
  const last = { particulars: 'NEXTROW' };
  const position = async (rows: unknown[]) => {
    const pdf = await renderer.render(async () => input(content, { budgetRows: [], actualRows: rows }));
    const bounds = /<word xMin="[\d.]+" yMin="([\d.]+)"[^>]*>NEXTROW<\/word>/.exec(readPdf('pdftotext', ['-bbox', '-', '-'], pdf));
    assert.ok(bounds);
    return Number(bounds[1]);
  };
  const consecutive = await position([first, last]);
  assert.ok(await position([first, null, last]) - consecutive >= 13);
});

test('print contexts block HTTP, files and script execution and recover from failed image decodes', { skip: chromiumSkip }, async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('unexpected'); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const directory = await mkdtemp(join(tmpdir(), 'ebdrms-blocked-file-'));
  t.after(() => rm(directory, { recursive: true }));
  const filename = join(directory, 'private.png');
  const cafoa = await readPublication('CAFOA');
  await writeFile(filename, Buffer.from(cafoa.renderSnapshot.assets.municipalLogo!.base64, 'base64'));
  const browser = await sandboxedChromium();
  const renderer = new PdfRenderer(async () => browser);
  t.after(() => renderer.close());
  const source = await readPublication('RAAOCO');
  const partial = source.renderSnapshot.partials['./_raao']!;
  const substitute = (markup: string) => ({ ...source,
    renderSnapshot: { ...source.renderSnapshot, partials: { './_raao': partial.replace('</main>', `${markup}</main>`) } } });

  // Deliberately bypass publication checks to exercise the browser's network isolation itself.
  for (const url of [`http://127.0.0.1:${address.port}/logo.png`, pathToFileURL(filename).href]) {
    await assert.rejects(renderer.render(async () => input(substitute(`<img src="${url}">`), {})), kind('render'));
    assert.equal(browser.contexts().length, 0);
  }
  const risky = '<img src="https://example.test/injected" onerror="intrusion()"> <%~ 2 + 2 %>';
  const scripted = substitute("<script>document.body.textContent = 'EXECUTED SCRIPT MARKER'</script>");
  const pdf = await renderer.render(async () => input(scripted, { budgetRows: [{ particulars: risky }], actualRows: [null] }));
  const text = readPdf('pdftotext', ['-', '-'], pdf).replace(/\s+/g, ' ');
  assert.match(text, /onerror/);
  assert.match(text, /<%~ 2 \+ 2 %>/);
  assert.doesNotMatch(text, /EXECUTED SCRIPT MARKER/);
  assert.equal(requests, 0);
  assert.equal(browser.contexts().length, 0);
});

test('concurrent renders reject excess demand and share one Chromium process', { skip: chromiumSkip }, async (t) => {
  let launches = 0;
  const renderer = new PdfRenderer(async () => { launches++; return sandboxedChromium(); });
  t.after(() => renderer.close());
  const work = input(await readPublication('RAAOFE'), {});
  const { promise, resolve } = Promise.withResolvers<typeof work>();
  const active = [renderer.render(() => promise), renderer.render(() => promise)];
  try {
    await assert.rejects(renderer.render(async () => { throw new Error('Excess input must not be loaded'); }), kind('busy'));
  } finally {
    resolve(work);
    const pdfs = await Promise.all(active);
    assert.ok(pdfs.every((pdf) => pdf.subarray(0, 5).toString() === '%PDF-'));
  }
  assert.equal(launches, 1);
});
