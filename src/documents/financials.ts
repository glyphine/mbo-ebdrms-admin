import type { DocField, DocValue, DocValues, FieldShape, TemplateCode } from '../templates/contracts.js';
import { DocumentValidationError } from '../templates/validation.js';

const metrics = ['appropriations', 'allotment', 'appropriationBalance', 'obligation', 'balance'] as const;
type Totals = Partial<Record<typeof metrics[number], bigint>>;

const asObject = (value: DocValue | undefined) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
const asList = (value: DocValue | undefined): DocValue[] => Array.isArray(value) ? value : [];
const asText = (value: DocValue | undefined) => typeof value === 'string' ? value : undefined;

function cents(value: DocValue | undefined) {
  if (typeof value !== 'string') return undefined;
  const [units = '', fraction = ''] = value.replace(/^-/, '').split('.');
  const amount = BigInt(units) * 100n + BigInt(fraction.padEnd(2, '0'));
  return value.startsWith('-') ? -amount : amount;
}

function decimal(value: bigint) {
  const magnitude = value < 0n ? -value : value;
  if (magnitude >= 10n ** 18n) throw new DocumentValidationError('Computed amount exceeds numeric(18,2)');
  return `${value < 0n ? '-' : ''}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}`;
}

const small = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const scales = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion'];

function words(value: bigint) {
  if (value === 0n) return 'zero';
  const groups: string[] = [];
  for (let index = 0; value > 0n; index++, value /= 1000n) {
    let part = Number(value % 1000n); // The group is exactly representable.
    if (!part) continue;
    const components: string[] = [];
    if (part >= 100) components.push(`${small[Math.floor(part / 100)]} hundred`);
    part %= 100;
    if (part >= 20) components.push(`${tens[Math.floor(part / 10)]}${part % 10 ? `-${small[part % 10]}` : ''}`);
    else if (part) components.push(small[part]!);
    const scale = scales[index];
    if (scale) components.push(scale);
    groups.unshift(components.join(' '));
  }
  return groups.join(' ');
}

function amountWords(value: bigint) {
  const magnitude = value < 0n ? -value : value;
  const pesos = magnitude / 100n;
  const centavos = magnitude % 100n;
  return `${value < 0n ? 'minus ' : ''}${words(pesos)} ${pesos === 1n ? 'peso' : 'pesos'}` +
    `${centavos ? ` and ${words(centavos)} ${centavos === 1n ? 'centavo' : 'centavos'}` : ''} only`;
}

export function deriveFinancialValues(code: TemplateCode, values: DocValues) {
  const aggregates = new Set<string>();
  function rejectDerived(object: DocValues, keys: readonly string[]) {
    for (const key of keys) {
      if (Object.hasOwn(object, key)) throw new DocumentValidationError(`${key} is a server-computed field`);
    }
  }
  function sum(values: (bigint | undefined)[]) {
    return values.some((value) => value !== undefined)
      ? values.reduce<bigint>((total, value) => total + (value ?? 0n), 0n) : undefined;
  }
  function computed(target: DocValues, key: string, path: string, value?: bigint, aggregate = true) {
    if (value === undefined) return;
    target[key] = decimal(value);
    if (aggregate) aggregates.add(`${path}${key}`);
  }
  function rollup(target: DocValues, key: string, path: string, children: Totals[]): Totals {
    const totals: Totals = {};
    const display: DocValues = {};
    for (const metric of metrics) {
      const total = sum(children.map((child) => child[metric]));
      if (total !== undefined) totals[metric] = total;
      computed(display, metric, `${path}${key}.`, total);
    }
    if (Object.keys(display).length) target[key] = display;
    return totals;
  }

  if (code === 'CAFOA') {
    rejectDerived(values, ['amount', 'amountWords']);
    const amount = sum(asList(values['details']).map((row) => cents(asObject(row)?.['amount'])));
    computed(values, 'amount', '', amount);
    if (amount !== undefined) values['amountWords'] = amountWords(amount);
    let running = 0n;
    asList(values['ledgers']).forEach((item, index) => {
      const row = asObject(item);
      if (!row) return;
      rejectDerived(row, ['balance']);
      const obligation = cents(row['obligation']);
      const liquidations = cents(row['liquidations']);
      if (obligation === undefined && liquidations === undefined) return;
      running += (obligation ?? 0n) - (liquidations ?? 0n);
      computed(row, 'balance', `ledgers[${index}].`, running);
    });
  } else if (code === 'SAAOB') {
    rejectDerived(values, ['grandTotals']);
    const offices = asList(values['offices']).map((item, officeIndex) => {
      const office = asObject(item)!;
      rejectDerived(office, ['totals']);
      const path = `offices[${officeIndex}].`;
      const categories = asList(office['categories']).map((item, categoryIndex) => {
        const category = asObject(item)!;
        rejectDerived(category, ['totals']);
        const categoryPath = `${path}categories[${categoryIndex}].`;
        const entries = asList(category['entries']).map((item, entryIndex) => {
          const entry = asObject(item)!;
          rejectDerived(entry, ['appropriationBalance', 'balance']);
          const appropriations = cents(entry['appropriations']);
          const allotment = cents(entry['allotment']);
          const obligation = cents(entry['obligation']);
          const entryPath = `${categoryPath}entries[${entryIndex}].`;
          if (appropriations !== undefined && allotment !== undefined) {
            computed(entry, 'appropriationBalance', entryPath, appropriations - allotment, false);
          }
          if (allotment !== undefined && obligation !== undefined) computed(entry, 'balance', entryPath, allotment - obligation, false);
          const totals: Totals = {};
          for (const metric of metrics) {
            const amount = cents(entry[metric]);
            if (amount !== undefined) totals[metric] = amount;
          }
          return totals;
        });
        return rollup(category, 'totals', categoryPath, entries);
      });
      return rollup(office, 'totals', path, categories);
    });
    rollup(values, 'grandTotals', '', offices);
  } else {
    for (const key of ['budgetRows', 'actualRows']) {
      asList(values[key]).forEach((item, index) => {
        const row = asObject(item);
        if (!row) return;
        rejectDerived(row, ['totalAmount']);
        computed(row, 'totalAmount', `${key}[${index}].`, sum(asList(row['details']).map(cents)));
      });
    }
  }
  return aggregates;
}

export function statementOfficeCodes(values: DocValues) {
  return [...new Set(asList(values['offices']).flatMap((item) => {
    const code = asText(asObject(item)?.['code']);
    return code ? [code] : [];
  }))];
}

interface FinancialValue {
  fieldPath: string;
  metricKey: string;
  amount: string;
  accountCode: string | null;
  officeId: string | null;
  isAggregate: boolean;
}

export function projectFinancialValues(fields: readonly DocField[], values: DocValues, aggregates: ReadonlySet<string>,
  officeIds: ReadonlyMap<string, string>) {
  const result: FinancialValue[] = [];
  function visit(shape: FieldShape, value: DocValue | undefined, path: string, metricKey: string,
    officeId: string | null, accountCode: string | null) {
    if (shape.type === 'money' && typeof value === 'string') {
      result.push({ fieldPath: path, metricKey, amount: value, officeId, accountCode, isAggregate: aggregates.has(path) });
    } else if (shape.type === 'group') {
      const row = asObject(value);
      if (!row) return;
      const code = asText(row['code']);
      const office = metricKey === 'offices' && code ? officeIds.get(code) ?? null : officeId;
      const account = asText(row['accountCode']) ?? asText(row['expenseCode']) ?? accountCode;
      for (const field of shape.fields) visit(field, row[field.key], `${path}.${field.key}`, field.key, office, account);
    } else if (shape.type === 'list') {
      asList(value).forEach((item, index) => visit(shape.items, item, `${path}[${index}]`, metricKey, officeId, accountCode));
    }
  }
  for (const field of fields) visit(field, values[field.key], field.key, field.key, null, null);
  return result;
}
