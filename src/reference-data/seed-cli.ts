import { config as loadDotenv } from 'dotenv';
import { createDatabase } from '../db/client.js';
import { seedReferenceData } from './seed.js';

try {
  loadDotenv({ quiet: true });
  const url = process.env['DATABASE_URL'];
  if (!url) {
    process.stderr.write('DATABASE_URL is required for the reference seed\n');
    process.exitCode = 1;
  } else {
    const database = createDatabase(url);
    try {
      process.stdout.write(`${JSON.stringify(await seedReferenceData(database.db), null, 2)}\n`);
    } finally {
      await database.close();
    }
  }
} catch {
  process.stderr.write('Reference seed failed. Check database configuration, permissions, and applied migrations.\n');
  process.exitCode = 1;
}
