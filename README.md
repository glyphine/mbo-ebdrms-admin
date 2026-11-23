# MBO EBDRMS Admin

A Fastify and TypeScript API for the Municipal Budget Office of Magpet's document and records management system.

## Overview

The API uses PostgreSQL with Drizzle. Application construction is in `src/app.ts`. The process entry point in `src/server.ts` loads and validates configuration, starts the listener, and closes Fastify and its connection pool on `SIGINT` or `SIGTERM`.

## Getting Started

Use Node.js 22, the pnpm version in `package.json`, and a PostgreSQL database for local development. Set `DATABASE_URL` to a PostgreSQL connection URL with a host and database name. `HOST` defaults to `0.0.0.0`, `PORT` to `3000`, and `NODE_ENV` to `development`. Use `test` or `production` to select those environments. The executable can load these values from an ignored local `.env` file.

Set `AUTH_JWT_KEYS` and `AUTH_JWT_ACTIVE_KID` before starting the API. See the [authentication contract](docs/authentication.md) for signing key configuration and rotation, the device-gated routes, and client credential storage.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm build` compiles the API and `pnpm start` runs the compiled server. Run `pnpm typecheck` and `pnpm test` to verify it. Set `DEVICE_TEST_DATABASE_URL` to a disposable database with the migrations applied to include the PostgreSQL auth and device tests.

| Route | Purpose |
| --- | --- |
| `GET /` | Existing hello endpoint |
| `GET /api/v1/ping?name=Magpet` | Versioned request and response example |
| `GET /health/live` | Process liveness independent of PostgreSQL |
| `GET /health/ready` | Bounded database probe, returning `503` on failure |
| `GET /openapi.json` | OpenAPI generated from registered route schemas |

API errors use an `error` object with `code`, `message`, and `requestId`. Request IDs correlate responses with structured server logs. Startup can complete during a database outage so readiness can recover when PostgreSQL returns.

See [device enrollment and session persistence](docs/device-enrollment.md) for the internal service contract and initial administrator bootstrap plan, and [authorization and access administration](docs/authorization.md) for grants, document rules, and administrator routes.

See [trusted template publication](docs/template-publication.md) for the reviewed publication command and template metadata API.

See [documents and revision history](docs/documents.md) for document routes, lifecycle rules, and structured values.

## Contributing

1. Create a feature branch.
2. Make focused changes and add or update tests where appropriate.
3. Open a pull request with a short summary of the change and verification steps.

## License

[Add the project license information here.]
