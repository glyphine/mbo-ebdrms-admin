import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 2000 });
  const db = drizzle({ client: pool });

  return {
    db,
    onIdleError: (handler: () => void) => { pool.on('error', handler); },
    async check() {
      const probe = { text: 'SELECT 1', query_timeout: 2000 };
      await pool.query(probe);
    },
    close: () => pool.end(),
  };
}

export type Database = ReturnType<typeof createDatabase>;
