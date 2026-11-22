import { isIP } from 'node:net';

export class ConfigurationError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const environment = env['NODE_ENV'] ?? 'development';
  if (environment !== 'development' && environment !== 'test' && environment !== 'production') {
    throw new ConfigurationError('NODE_ENV must be development, test, or production');
  }

  const databaseUrl = env['DATABASE_URL'] ?? '';
  const url = URL.parse(databaseUrl);
  if (
    !url || (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
    !url.hostname || url.pathname.length < 2 || url.hash || /\s|%(?![\da-f]{2})/i.test(databaseUrl) ||
    Number(url.port) > 65535
  ) {
    throw new ConfigurationError('DATABASE_URL must be a PostgreSQL URL with a host and database name');
  }

  const host = env['HOST'] ?? '0.0.0.0';
  const hostname = /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.?$/i;
  if (!isIP(host) && (host.length > 253 || !hostname.test(host))) {
    throw new ConfigurationError('HOST must be a hostname or IP address');
  }

  const portText = env['PORT'] ?? '3000';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    throw new ConfigurationError('PORT must be an integer between 1 and 65535');
  }

  return { environment, databaseUrl, host, port };
}

export type Config = ReturnType<typeof loadConfig>;
