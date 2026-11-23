import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './client.js';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  process.stderr.write('DATABASE_URL is required to apply migrations\n');
  process.exitCode = 1;
} else {
  const database = createDatabase(databaseUrl);
  try {
    const result = await migrate(database.db, { migrationsFolder: fileURLToPath(new URL('../../drizzle/', import.meta.url)) });
    if (result) throw new Error('Migration initialization failed');
    process.stdout.write('Database migrations applied\n');
  } catch {
    process.stderr.write('Database migrations failed. Check the target and reviewed migration history.\n');
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}
