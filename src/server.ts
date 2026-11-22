import { config as loadDotenv } from 'dotenv';
import { createApp } from './app.js';
import { ConfigurationError, loadConfig } from './config.js';

async function start() {
  const config = loadConfig();
  const app = createApp(config);
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    throw error;
  }

  function shutdown() {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    void app.close().catch(() => {
      app.log.error('Server shutdown failed');
      process.exitCode = 1;
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

try {
  loadDotenv({ quiet: true });
  await start();
} catch (error) {
  const message = error instanceof ConfigurationError ? error.message : 'Server startup failed';
  process.stderr.write(`${JSON.stringify({ level: 'error', message })}\n`);
  process.exitCode = 1;
}
