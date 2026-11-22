import { isIP } from 'node:net';

export class ConfigurationError extends Error {}

function loadJwtConfig(env: NodeJS.ProcessEnv) {
  const activeKid = env['AUTH_JWT_ACTIVE_KID'] ?? '';
  const keys = new Map<string, Buffer>();
  try {
    const entries: unknown = JSON.parse(env['AUTH_JWT_KEYS'] ?? 'null');
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error();
    for (const [kid, value] of Object.entries(entries)) {
      if (!kid || kid.length > 64 || /[^A-Za-z0-9_-]/.test(kid) ||
          typeof value !== 'string' || value.length !== 43) throw new Error();
      const key = Buffer.from(value, 'base64url');
      if (key.length !== 32 || key.toString('base64url') !== value) throw new Error();
      keys.set(kid, key);
    }
  } catch {
    throw new ConfigurationError('AUTH_JWT_KEYS must be a JSON object of key IDs and base64url-encoded 32-byte keys');
  }
  if (!keys.has(activeKid)) throw new ConfigurationError('AUTH_JWT_ACTIVE_KID must name a configured signing key');

  const issuer = env['AUTH_JWT_ISSUER'] ?? 'ebdrms-api';
  const audience = env['AUTH_JWT_AUDIENCE'] ?? 'ebdrms-mobile';
  if ([issuer, audience].some((value) => !value || value.length > 255 || /\s/.test(value))) {
    throw new ConfigurationError('AUTH_JWT_ISSUER and AUTH_JWT_AUDIENCE must be nonblank identifiers');
  }
  return { keys, activeKid, issuer, audience };
}

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

  return { environment, databaseUrl, host, port, jwt: loadJwtConfig(env) };
}

export type Config = ReturnType<typeof loadConfig>;
