import type { DocEntry, DocField, FieldShape, PdfOptions, TemplateCode } from './contracts.js';

const text = (key: string, label: string, maxLength = 160): DocField => ({ key, label, type: 'text', maxLength, nullable: true });
const money = (key: string, label: string): DocField => ({ key, label, type: 'money', nullable: true });
const date = (key: string, label: string): DocField => ({ key, label, type: 'date', nullable: true });
const group = (key: string, label: string, fields: readonly DocField[]): DocField => ({ key, label, type: 'group', fields, nullable: true });
const list = (key: string, label: string, maxItems: number, items: FieldShape): DocField =>
  ({ key, label, type: 'list', maxItems, items, nullable: true });
const rows = (key: string, label: string, maxItems: number, fields: readonly DocField[], nullable = false): DocField =>
  list(key, label, maxItems, { type: 'group', fields, nullable });
const serial = text('serialNumber', 'Serial number', 64);

function signatory(prefix: string, label: string, dated = false): DocField[] {
  return [text(`${prefix}Name`, `${label} name`), text(`${prefix}Title`, `${label} title`),
    ...(dated ? [date(`${prefix}Date`, `${label} date`)] : [])];
}

const cafoa = [
  serial, text('payeeName', 'Payee'), money('amount', 'Total amount requested'), text('amountWords', 'Amount in words', 500),
  ...signatory('official', 'Requesting official', true), text('obligationNumber', 'Obligation number', 64),
  money('approvedAmount', 'Approved amount'), ...signatory('signatory1', 'Appropriation certification', true),
  ...signatory('signatory2', 'Funds availability certification', true), ...signatory('signatory3', 'Obligation certification', true),
  rows('details', 'Request details', 200, [text('function', 'Function'), text('allotmentClass', 'Allotment class'),
    text('expenseCode', 'Expense code', 64), money('amount', 'Amount')], true),
  rows('ledgers', 'Subsidiary ledger', 200, [date('date', 'Date'), text('particulars', 'Particulars', 500),
    money('liquidations', 'Liquidations'), money('obligation', 'Obligation increase'), money('balance', 'Balance')], true),
] satisfies DocField[];

const raaoRow = [money('appropriationAmount', 'Appropriation'), money('allotmentAmount', 'Allotment'), date('date', 'Date'),
  text('referenceNumber', 'Reference or CAFOA number', 64), text('particulars', 'Particulars', 500),
  money('totalAmount', 'Total allotment or obligation'), list('details', 'Detail columns', 8, { type: 'money', nullable: true })];
const raao = [serial, text('reportingMonth', 'Reporting month'), text('fund', 'Fund'), text('sheetNumber', 'Sheet number', 64),
  text('functionProgramProject', 'Function, program or project'), rows('budgetRows', 'Budget rows', 200, raaoRow, true),
  rows('actualRows', 'Actual rows', 200, raaoRow, true)];

const saaobMoney = [money('appropriations', 'Appropriations'), money('allotment', 'Allotment'),
  money('appropriationBalance', 'Appropriation balance'), money('obligation', 'Obligation'), money('balance', 'Balance')];
const saaobTotals = group('totals', 'Totals', saaobMoney);
const saaob = [serial, text('startDate', 'Start date display', 64), text('endDate', 'End date display', 64),
  ...signatory('preparedBy', 'Prepared by'), ...signatory('certifiedBy', 'Certified by'),
  rows('offices', 'Offices', 80, [text('name', 'Office name'), text('code', 'Office code', 32),
    rows('categories', 'Categories', 24, [text('name', 'Category name'),
      rows('entries', 'Entries', 150, [text('name', 'Entry name'), text('accountCode', 'Account code', 64), ...saaobMoney]),
      saaobTotals]), saaobTotals]), group('grandTotals', 'Grand totals', saaobMoney)];

function entry(code: TemplateCode, name: string, layout: DocEntry['layout'], fields: readonly DocField[]): DocEntry {
  const basename = code.toLowerCase() as Lowercase<TemplateCode>;
  const pdfOptions: PdfOptions = { format: 'A4', landscape: layout === 'raao', displayHeaderFooter: false, printBackground: true,
    margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' } };
  return { code, name, resourceKey: `/templates/${basename}`, sourceFile: `${basename}.eta`, fields, pdfOptions, layout };
}

export const documentRegistry: Readonly<Record<TemplateCode, DocEntry>> = {
  CAFOA: entry('CAFOA', 'Certification on Appropriations, Funds, and Obligation of Allotment', 'cafoa', cafoa),
  RAAOCO: entry('RAAOCO', 'Registry on Appropriations Allotment and Obligations - Capital Outlay', 'raao', raao),
  RAAOFE: entry('RAAOFE', 'Registry on Appropriations Allotment and Obligations - Financial Expenses', 'raao', raao),
  RAAOMOOE: entry('RAAOMOOE', 'Registry on Appropriations Allotment and Obligations - Maintenance and Other Operating Expenses', 'raao', raao),
  RAAOPS: entry('RAAOPS', 'Registry on Appropriations Allotment and Obligations - Personal Services', 'raao', raao),
  SAAOB: entry('SAAOB', 'Statement of Appropriation, Allotment, Obligation & Balances', 'saaob', saaob),
};
