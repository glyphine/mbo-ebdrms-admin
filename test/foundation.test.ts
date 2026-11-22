import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { ConfigurationError, loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';

const databaseUrl = 'postgresql://test@localhost/ebdrms_test';
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl });

function assertError(response: { statusCode: number; json(): unknown }, status: number, code: string, message: string) {
  assert.equal(response.statusCode, status);
  const body = response.json() as { error: { requestId: string } };
  assert.match(body.error.requestId, /^[\da-f-]{36}$/);
  assert.deepEqual(body, { error: { code, message, requestId: body.error.requestId } });
}

test('configuration is validated in all environments', () => {
  for (const environment of ['development', 'test', 'production']) {
    assert.deepEqual(loadConfig({ NODE_ENV: environment, DATABASE_URL: databaseUrl }), {
      environment, databaseUrl, host: '0.0.0.0', port: 3000,
    });
    assert.throws(() => loadConfig({ NODE_ENV: environment }), ConfigurationError);
  }
  for (const env of [
    { NODE_ENV: 'staging' },
    { HOST: '/tmp/api.sock' },
    { HOST: 'localhost:3000' },
    { PORT: '65536' },
    { PORT: '3e3' },
    { DATABASE_URL: 'https://localhost/ebdrms' },
    { DATABASE_URL: 'postgresql://localhost' },
  ]) {
    assert.throws(() => loadConfig({ DATABASE_URL: databaseUrl, ...env }), ConfigurationError);
  }
});

test('server exits with a safe startup error for invalid configuration', async () => {
  const secret = 'startup-test-secret';
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: `http://user:${secret}@localhost/ebdrms` },
      timeout: 5000,
    }, (error, stdout, stderr) => {
      try {
        assert.equal(error?.code, 1);
        assert.match(stderr, /DATABASE_URL must be a PostgreSQL URL/);
        assert.doesNotMatch(stderr + stdout, new RegExp(secret));
        resolve();
      } catch (assertionError) {
        reject(assertionError);
      }
    });
  });
});

test('app boots and registers the legacy and versioned routes', async (t) => {
  const app = createApp(config);
  t.after(() => app.close());
  await app.ready();
  assert.ok(app.db);
  assert.deepEqual((await app.inject('/')).json(), { hello: 'world' });
  assert.deepEqual((await app.inject('/api/v1/ping?name=Magpet')).json(), { hello: 'Magpet' });

  const response = await app.inject('/openapi.json');
  assert.equal(response.statusCode, 200);
  const document = response.json();
  assert.equal(document.openapi, '3.0.3');
  assert.deepEqual(document.paths['/api/v1/ping'].get.parameters[0].schema, {
    type: 'string', maxLength: 100,
  });
  assert.ok(document.paths['/health/ready'].get.responses['503']);
  assert.equal(document.paths['/openapi.json'], undefined);
});

test('liveness is independent of the database, readiness recovers, and shutdown closes the pool', async (t) => {
  const database = createDatabase(databaseUrl);
  const close = t.mock.method(database, 'close');
  const check = t.mock.method(database, 'check', async () => {
    throw new Error('db-test-secret');
  });
  const app = createApp(config, { database });
  t.after(() => app.close());

  assert.deepEqual((await app.inject('/health/live')).json(), { status: 'ok' });
  assert.equal(check.mock.callCount(), 0);
  assertError(await app.inject('/health/ready'), 503, 'SERVICE_UNAVAILABLE', 'Database unavailable');
  check.mock.mockImplementation(async () => {});
  const ready = await app.inject('/health/ready');
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), { status: 'ok' });
  assert.equal(check.mock.callCount(), 2);

  await app.close();
  assert.equal(close.mock.callCount(), 1);
});

test('validation, routing and internal errors use the same envelope and logs omit secrets', async (t) => {
  let logs = '';
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      logs += chunk.toString();
      callback();
    },
  });
  const app = createApp(config, { logStream });
  t.after(() => app.close());
  app.get('/test-error', async (request) => {
    request.log.info({ refreshToken: 'refresh-test-secret' }, 'Test redaction');
    throw new Error('internal-test-secret');
  });

  for (const query of ['name=a&name=b', `name=${'a'.repeat(101)}`, 'other=query-test-secret']) {
    assertError(await app.inject(`/api/v1/ping?${query}`), 400, 'VALIDATION_ERROR', 'Request validation failed');
  }
  assertError(await app.inject('/missing'), 404, 'NOT_FOUND', 'Route not found');
  assertError(await app.inject('/api/v1/%GG'), 400, 'REQUEST_ERROR', 'Bad Request');
  assertError(await app.inject({
    url: '/test-error?password=query-test-secret',
    headers: { authorization: 'Bearer header-test-secret', cookie: 'session=cookie-test-secret' },
  }), 500, 'INTERNAL_ERROR', 'Internal server error');
  assert.doesNotMatch(logs, /(?:internal|header|query|cookie|refresh)-test-secret/);
  assert.match(logs, /\[Redacted\]/);
  assert.match(logs, /"reqId":"[\da-f-]{36}"/);
});
