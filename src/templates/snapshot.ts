import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocField, PdfOptions, RenderSnapshot, TemplateCode } from './contracts.js';
import { documentRegistry } from './registry.js';
import { validateDocumentValues } from './validation.js';

const templateDirectory = fileURLToPath(new URL('../../templates/', import.meta.url));
const logoFile = 'assets/magpet-logo.png';
const logoSha256 = '6dddd3e285198a90af0a953d729e8f38e01a67ab91490f3df7178ffa3d8bcaf0';
const logoSlot = 'src="<%= it.logoSrc %>"';

export interface SnapshotContent {
  templateSource: string;
  fieldSchema: readonly DocField[];
  pdfOptions: PdfOptions;
  renderSnapshot: RenderSnapshot;
}

const sha256 = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function snapshotDigest(content: SnapshotContent) {
  return sha256(canonicalJson({ templateSource: content.templateSource, fieldSchema: content.fieldSchema,
    pdfOptions: content.pdfOptions, renderSnapshot: content.renderSnapshot }));
}

async function readReviewedFile(directory: string, relativePath: string, maxBytes: number) {
  const path = join(directory, relativePath);
  if (await realpath(path) !== path) throw new Error(`Template file must be a regular repository file: ${relativePath}`);
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw new Error(`Template file exceeds its expected bounds: ${relativePath}`);
  return readFile(path);
}

// These checks catch drift in the reviewed repository inputs. Deploy-time review and digest approval establish trust.
function checkLayout(source: string, hasLogo: boolean) {
  const markup = source.replace(logoSlot, '');
  if ((hasLogo && !source.includes(logoSlot)) || /<%[-_]?\s*~|\binclude(?:Async)?\s*\(/.test(markup) ||
      /<(?:script|iframe|object|embed|link|base)\b|\b(?:src|srcset|href|action|poster|on[a-z]+)\s*=/i.test(markup) ||
      /@import\b|\burl\s*\(/i.test(markup)) {
    throw new Error('Layout contains an unsupported resource, script or raw interpolation');
  }
}

// directory is a trusted checkout path, supplied only by maintenance code and tests.
export async function readPublication(code: TemplateCode, directory = templateDirectory): Promise<SnapshotContent> {
  if (!Object.hasOwn(documentRegistry, code)) throw new Error('Unknown template code');
  const definition = documentRegistry[code];
  const root = await realpath(directory);
  const printFiles = ['print/common.css', `print/${definition.layout}.css`] as const;
  const [source, commonCss, layoutCss] = await Promise.all([
    readReviewedFile(root, definition.sourceFile, 64 * 1024),
    readReviewedFile(root, printFiles[0], 16 * 1024),
    readReviewedFile(root, printFiles[1], 16 * 1024),
  ]);
  const templateSource = source.toString('utf8');
  const printCss = `${commonCss.toString('utf8')}\n${layoutCss.toString('utf8')}`;
  if (/@import\b|\burl\s*\(/i.test(printCss)) throw new Error('Print CSS cannot load external resources');
  const renderSnapshot: RenderSnapshot = {
    format: 1, code, sourceFile: definition.sourceFile, printFiles, printCss, partials: {}, assets: {},
    engines: { eta: '4.6.0', tailwind: '4.3.5' },
  };

  if (definition.layout === 'raao') {
    const wrapper = /^<%~ include\('\.\/_raao', \{ \.\.\.it, documentCode: '([A-Z]+)', allotmentClass: '[A-Za-z ]+', \}\) %>$/;
    if (wrapper.exec(templateSource.trim())?.[1] !== code) throw new Error('Unexpected RAAO wrapper');
    const partial = (await readReviewedFile(root, '_raao.eta', 64 * 1024)).toString('utf8');
    checkLayout(partial, false);
    renderSnapshot.partials['./_raao'] = partial;
  } else {
    checkLayout(templateSource, code === 'CAFOA');
  }
  if (code === 'CAFOA') {
    const logo = await readReviewedFile(root, logoFile, 4 * 1024 * 1024);
    const digest = sha256(logo);
    if (digest !== logoSha256) throw new Error('Municipal logo does not match the approved asset digest');
    renderSnapshot.assets.municipalLogo = { sourceFile: logoFile, mediaType: 'image/png', sha256: digest, base64: logo.toString('base64') };
  }

  return { templateSource, fieldSchema: structuredClone(definition.fields), pdfOptions: structuredClone(definition.pdfOptions), renderSnapshot };
}

// Call with a verified stored snapshot. Eta must use escaped interpolation and only these snapshot partials.
export function prepareTemplateData(content: SnapshotContent, input: unknown) {
  const data = validateDocumentValues(content.fieldSchema, input);
  const logo = content.renderSnapshot.assets.municipalLogo;
  return logo ? { ...data, logoSrc: `data:${logo.mediaType};base64,${logo.base64}` } : data;
}
