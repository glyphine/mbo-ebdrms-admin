import { config as loadDotenv } from 'dotenv';
import { createDatabase } from '../db/client.js';
import { templateCodes } from './contracts.js';
import { publishTemplate } from './publication.js';
import { readPublication, snapshotDigest } from './snapshot.js';

async function main() {
  const [operation, codeArg, actor, digest, ...rest] = process.argv.slice(2);
  const code = templateCodes.find((entry) => entry === codeArg);
  if (code && operation === 'inspect' && actor === undefined) {
    const content = await readPublication(code);
    process.stdout.write(`${JSON.stringify({ code, digest: snapshotDigest(content) })}\n`);
    return;
  }
  if (!code || operation !== 'publish' || rest.length > 0 || !actor ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(actor) || actor.length !== 36 ||
      !digest || digest.length !== 64 || /[^a-f0-9]/.test(digest)) {
    throw new Error('Usage: pnpm templates inspect CODE | pnpm templates publish CODE ACTOR_UUID APPROVED_SHA256');
  }
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is required for publication');
  const database = createDatabase(databaseUrl);
  try {
    const result = await publishTemplate(database.db, code, actor, digest);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await database.close();
  }
}

try {
  loadDotenv({ quiet: true });
  await main();
} catch (error) {
  // Drizzle's query errors can contain source/assets as SQL parameters.
  const message = error instanceof Error && !error.cause && !('code' in error) ? error.message : 'Check database configuration and migrations';
  process.stderr.write(`Template operation failed. ${message}\n`);
  process.exitCode = 1;
}
