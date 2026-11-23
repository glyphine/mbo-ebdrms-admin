export type DocValue = string | number | boolean | null | DocValue[] | DocValues;
export type DocValues = { [key: string]: DocValue };

export type FieldShape = { nullable?: boolean } & (
  | { type: 'text'; maxLength: number }
  | { type: 'date' | 'money' }
  | { type: 'group'; fields: readonly DocField[] }
  | { type: 'list'; maxItems: number; items: FieldShape }
);

export type DocField = FieldShape & { key: string; label: string; required?: boolean };

export interface PdfOptions {
  format: 'A3' | 'A4' | 'A5' | 'Letter' | 'Legal';
  landscape: boolean;
  displayHeaderFooter: boolean;
  printBackground: boolean;
  margin: { top: string; right: string; bottom: string; left: string };
}

export const templateCodes = ['CAFOA', 'RAAOCO', 'RAAOFE', 'RAAOMOOE', 'RAAOPS', 'SAAOB'] as const;
export type TemplateCode = typeof templateCodes[number];

export interface DocEntry {
  code: TemplateCode;
  name: string;
  resourceKey: `/templates/${Lowercase<TemplateCode>}`;
  sourceFile: `${Lowercase<TemplateCode>}.eta`;
  fields: readonly DocField[];
  pdfOptions: PdfOptions;
  layout: 'cafoa' | 'raao' | 'saaob';
}

export interface RenderSnapshot {
  format: 1;
  code: TemplateCode;
  sourceFile: DocEntry['sourceFile'];
  partials: Record<string, string>;
  printFiles: readonly string[];
  printCss: string;
  engines: { eta: string; tailwind: string };
  assets: { municipalLogo?: { sourceFile: string; mediaType: 'image/png'; sha256: string; base64: string } };
}
