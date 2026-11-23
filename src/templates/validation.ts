import type { DocField, DocValue, DocValues, FieldShape } from './contracts.js';

export class DocumentValidationError extends Error {}

const moneyPattern = /^-?(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,2})?$/;
const datePattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const maxDepth = 12;
const maxNodes = 20_000;
const maxStringBytes = 256 * 1024;

export function validateDocumentValues(fields: readonly DocField[], input: unknown): DocValues {
  let nodes = 0;
  let stringBytes = 0;

  function invalid(path: string, reason: string): never {
    throw new DocumentValidationError(`${path}: ${reason}`);
  }

  function object(fields: readonly DocField[], value: unknown, path: string, depth: number): DocValues {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'expected an object');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid(path, 'expected a JSON object');
    const entries = value as Record<string, unknown>;
    const known = new Map(fields.map((field) => [field.key, field]));
    if (Object.keys(entries).some((key) => !known.has(key))) invalid(path, 'contains an unknown field');
    const valid: [string, DocValue][] = [];
    for (const field of fields) {
      const fieldPath = `${path}.${field.key}`;
      if (Object.hasOwn(entries, field.key)) valid.push([field.key, visit(field, entries[field.key], fieldPath, depth + 1)]);
      else if (field.required) invalid(fieldPath, 'required');
    }
    return Object.fromEntries(valid);
  }

  function visit(shape: FieldShape, value: unknown, path: string, depth: number): DocValue {
    if (++nodes > maxNodes || depth > maxDepth) invalid(path, 'document exceeds structural bounds');
    if (value === null && shape.nullable) return null;
    if (shape.type === 'list') {
      if (!Array.isArray(value) || value.length > shape.maxItems) invalid(path, `expected an array of at most ${shape.maxItems} items`);
      return Array.from(value, (item: unknown, index) => visit(shape.items, item, `${path}[${index}]`, depth + 1));
    }
    if (shape.type === 'group') return object(shape.fields, value, path, depth);

    if (typeof value !== 'string' || value.includes('\0') || !value.isWellFormed()) invalid(path, 'expected a valid string');
    stringBytes += Buffer.byteLength(value);
    if (stringBytes > maxStringBytes) invalid(path, 'document exceeds text size limit');
    if (shape.type === 'text' && [...value].length > shape.maxLength) invalid(path, `max length is ${shape.maxLength}`);
    if (shape.type === 'money' && (!moneyPattern.test(value) || /\s/.test(value))) invalid(path, 'expected an exact decimal string fitting numeric(18,2)');
    if (shape.type === 'date') {
      const parsed = new Date(value);
      if (value.length !== 10 || !datePattern.test(value) || !Number.isFinite(parsed.getTime()) ||
          parsed.toISOString().slice(0, 10) !== value || value.startsWith('0000')) invalid(path, 'expected a calendar date in YYYY-MM-DD format');
    }
    return value;
  }

  return object(fields, input, '$', 0);
}
