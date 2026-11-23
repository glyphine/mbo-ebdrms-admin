import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { compile } from '@tailwindcss/node';
import { Eta } from 'eta/core';
import etaPackage from 'eta/package.json' with { type: 'json' };
import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import tailwindPackage from 'tailwindcss/package.json' with { type: 'json' };
import type { FinancialPrintView } from '../reports/print.js';
import { templateCodes } from '../templates/contracts.js';
import type { PdfOptions } from '../templates/contracts.js';
import { prepareTemplateData } from '../templates/snapshot.js';
import type { SnapshotContent } from '../templates/snapshot.js';

const maxRows = 1_000;
const maxHtmlBytes = 8 * 1024 * 1024;
const maxPdfBytes = 12 * 1024 * 1024;
const cacheSize = 24;
const formats = ['A3', 'A4', 'A5', 'Letter', 'Legal'];
const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
const printContextOptions = { javaScriptEnabled: false, offline: true, serviceWorkers: 'block', acceptDownloads: false } as const;

export class PdfRenderError extends Error {
  constructor(readonly kind: 'busy' | 'timeout' | 'limit' | 'render', options?: ErrorOptions) {
    super('PDF rendering failed', options);
  }
}

interface RenderInput {
  content: SnapshotContent;
  contentDigest: string;
  values: unknown;
}

function until<T>(work: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PdfRenderError('timeout')), milliseconds);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function pdfOptions(options: PdfOptions): PdfOptions {
  if (!formats.includes(options.format) ||
      [options.landscape, options.displayHeaderFooter, options.printBackground].some((flag) => typeof flag !== 'boolean') ||
      ['top', 'right', 'bottom', 'left'].some((side) => {
        const value = options.margin?.[side as keyof PdfOptions['margin']];
        return typeof value !== 'string' || !/^(?:0|\d{1,3}(?:\.\d{1,2})?(?:mm|cm|in|px))$/.test(value);
      })) throw new PdfRenderError('render');
  return { format: options.format, landscape: options.landscape, displayHeaderFooter: options.displayHeaderFooter,
    printBackground: options.printBackground, margin: { top: options.margin.top, right: options.margin.right,
      bottom: options.margin.bottom, left: options.margin.left } };
}

function verifyAssets(content: SnapshotContent) {
  const { code, assets } = content.renderSnapshot;
  const logo = assets.municipalLogo;
  if (code !== 'CAFOA') {
    if (Object.keys(assets).length) throw new PdfRenderError('render');
    return;
  }
  if (!logo || Object.keys(assets).length !== 1 || logo.mediaType !== 'image/png' ||
      typeof logo.base64 !== 'string' || logo.base64.length > Math.ceil(4 * 1024 * 1024 / 3) * 4) {
    throw new PdfRenderError('render');
  }
  const png = Buffer.from(logo.base64, 'base64');
  if (png.length > 4 * 1024 * 1024 || png.toString('base64') !== logo.base64 ||
      png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      createHash('sha256').update(png).digest('hex') !== logo.sha256) throw new PdfRenderError('render');
}

const resolvePackage = createRequire(import.meta.url).resolve;
const tailwindEntry = resolvePackage('tailwindcss/index.css');
const tailwindFiles = new Map([
  ['tailwindcss', tailwindEntry],
  ...['theme.css', 'preflight.css', 'utilities.css'].map((file) => [`./${file}`, join(dirname(tailwindEntry), file)] as const),
]);

function compileTemplate(content: SnapshotContent) {
  const { renderSnapshot: snapshot, templateSource } = content;
  if (!templateCodes.includes(snapshot.code) || snapshot.engines.eta !== etaPackage.version || snapshot.engines.tailwind !== tailwindPackage.version) {
    throw new PdfRenderError('render');
  }
  verifyAssets(content);
  const partials = Object.keys(snapshot.partials);
  let shared: string | undefined;
  if (snapshot.code.startsWith('RAAO')) {
    shared = snapshot.partials['./_raao'];
    if (partials.length !== 1 || typeof shared !== 'string') throw new PdfRenderError('render');
  } else if (partials.length) {
    throw new PdfRenderError('render');
  }
  return compilePage(templateSource, snapshot.printCss, pdfOptions(content.pdfOptions), shared);
}

async function compilePage(templateSource: string, printCss: string, options: PdfOptions, shared?: string) {
  const eta = new Eta({ autoEscape: true }); // eta/core has no filesystem resolver.
  if (shared !== undefined) eta.loadTemplate('./_raao', shared);
  const template = eta.compile(templateSource);

  const sources = shared === undefined ? [templateSource] : [templateSource, shared];
  const inline = sources.flatMap((source) => [...source.matchAll(/<style type="text\/tailwindcss">([\s\S]*?)<\/style>/g)]
    .map((match) => match[1] ?? ''));
  // Utility discovery uses only reviewed literal class lists. The conditional empty-row class is defined in inline CSS.
  const candidates = sources.flatMap((source) => [...source.matchAll(/\bclass="([^"<>]*)"/g)]
    .flatMap((match) => match[1]?.trim().split(/\s+/) ?? []));
  const compiler = await compile(`@import "tailwindcss" source(none);\n${inline.join('\n')}`, {
    base: dirname(tailwindEntry), onDependency: () => {},
    customCssResolver: async (id) => {
      const file = tailwindFiles.get(id);
      if (!file) throw new PdfRenderError('render');
      return file;
    },
    customJsResolver: async () => { throw new PdfRenderError('render'); },
  });
  const css = `${compiler.build([...new Set(candidates)])}\n${printCss}`;
  if (Buffer.byteLength(css) > 128 * 1024 || /<\/style\b/i.test(css)) throw new PdfRenderError('render');
  return { eta, template, options, css };
}

async function compileReportTemplate() {
  const [source, css] = await Promise.all([
    readFile(new URL('../../templates/financial-report.eta', import.meta.url), 'utf8'),
    readFile(new URL('../../templates/print/financial-report.css', import.meta.url), 'utf8'),
  ]);
  return compilePage(source, css, { format: 'A4', landscape: false, displayHeaderFooter: false, printBackground: true,
    margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' } });
}

async function restrictPrintContext(context: BrowserContext) {
  await context.route('**/*', async (route) => route.abort('blockedbyclient'));
}

const launchChromium = () => chromium.launch({ headless: true, chromiumSandbox: true, timeout: 8_000 });

export class PdfRenderer {
  private browser: Promise<Browser> | undefined;
  private readonly prepared = new Map<string, ReturnType<typeof compileTemplate>>();
  private running = 0;
  private closed = false;

  constructor(private readonly launch = launchChromium, private readonly deadlineMs = 15_000) {}

  private getBrowser() {
    if (!this.browser) {
      const pending = this.launch();
      this.browser = pending;
      const reset = () => { if (this.browser === pending) this.browser = undefined; };
      void pending.then((browser) => browser.once('disconnected', reset), reset);
    }
    return this.browser;
  }

  private compile(key: string, build: () => ReturnType<typeof compilePage>) {
    const cached = this.prepared.get(key);
    this.prepared.delete(key);
    const prepared = cached ?? build();
    this.prepared.set(key, prepared);
    if (this.prepared.size > cacheSize) this.prepared.delete(this.prepared.keys().next().value!);
    if (!cached) void prepared.catch(() => { if (this.prepared.get(key) === prepared) this.prepared.delete(key); });
    return prepared;
  }

  render(load: () => Promise<RenderInput>) {
    return this.renderBounded(async () => {
      const input = await until(load(), 5_000);
      return { prepared: this.compile(input.contentDigest, async () => compileTemplate(input.content)),
        data: () => prepareTemplateData(input.content, input.values) };
    });
  }

  renderReport(view: FinancialPrintView) {
    return this.renderBounded(async () => ({ prepared: this.compile('financial-report', compileReportTemplate), data: () => view }));
  }

  private async renderBounded(load: () => Promise<{ prepared: ReturnType<typeof compilePage>; data: () => object }>) {
    if (this.closed || this.running >= 2) throw new PdfRenderError('busy');
    this.running++;
    try {
      const { prepared, data } = await load();
      const { eta, template, css, options } = await until(prepared, 5_000);
      const markup = eta.render(template, data());
      const html = markup.replace(/<head>/i, () => `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${css}</style>`);
      if (html === markup) throw new PdfRenderError('render');
      if (Buffer.byteLength(html) > maxHtmlBytes || (markup.match(/<tr(?=[\s>])/gi)?.length ?? 0) > maxRows) {
        throw new PdfRenderError('limit');
      }
      return await this.print(html, options);
    } finally {
      this.running--;
    }
  }

  private async print(html: string, options: PdfOptions) {
    const browser = await this.getBrowser().catch((cause: unknown) => { throw new PdfRenderError('render', { cause }); });
    const context = browser.newContext(printContextOptions);
    let cleanupStarted = false;
    const work = async () => {
      const session = await context;
      if (cleanupStarted) throw new PdfRenderError('timeout');
      await restrictPrintContext(session);
      const page = await session.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: this.deadlineMs });
      // DevTools evaluation does not enable JavaScript execution by the document.
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images, (image) => image.decode()));
      });
      const pdf = await page.pdf(options);
      if (pdf.length > maxPdfBytes) throw new PdfRenderError('limit');
      return pdf;
    };
    try {
      return await until(work(), this.deadlineMs);
    } catch (error) {
      if (error instanceof PdfRenderError) throw error;
      if (error instanceof Error && error.name === 'TimeoutError') throw new PdfRenderError('timeout', { cause: error });
      throw new PdfRenderError('render', { cause: error });
    } finally {
      cleanupStarted = true;
      try {
        await until(context.then((session) => session.close(), () => undefined), 1_000);
      } catch {
        // Retire a browser whose context cannot be disposed. Keep its promise until it disconnects.
        void browser.close().catch(() => {});
      }
    }
  }

  async close() {
    this.closed = true;
    this.prepared.clear();
    const browser = await this.browser?.catch(() => undefined);
    if (browser?.isConnected()) await browser.close();
  }
}
