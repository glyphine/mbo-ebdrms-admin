import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { expenditureClassificationsTable, fundsTable, officesTable } from '../db/schema.js';

type Reader = Pick<Database['db'], 'select'>;

export function findOfficesByCodes(db: Reader, codes: string[]) {
  return db.select().from(officesTable).where(inArray(officesTable.code, codes));
}

export async function findFund(db: Reader, code: string) {
  const [fund] = await db.select().from(fundsTable).where(eq(fundsTable.code, code));
  return fund;
}

export function listFunds(db: Reader) {
  return db.select().from(fundsTable).orderBy(fundsTable.code);
}

export function listExpenditureClassifications(db: Reader) {
  return db.select().from(expenditureClassificationsTable).orderBy(expenditureClassificationsTable.code);
}
