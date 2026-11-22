# MBO EBDRMS Admin

A Fastify and TypeScript API for the Municipal Budget Office of Magpet's document and records management system.

## Overview

The API uses PostgreSQL with Drizzle. Application construction is in `src/app.ts`. The process entry point in `src/server.ts` loads and validates configuration, starts the listener, and closes Fastify and its connection pool on `SIGINT` or `SIGTERM`.

## Getting Started

Use Node.js 22, the pnpm version in `package.json`, and a PostgreSQL database for local development. Set `DATABASE_URL` to a PostgreSQL connection URL with a host and database name. `HOST` defaults to `0.0.0.0`, `PORT` to `3000`, and `NODE_ENV` to `development`. Use `test` or `production` to select those environments. The executable can load these values from an ignored local `.env` file.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm build` compiles the API and `pnpm start` runs the compiled server. `pnpm typecheck` and `pnpm test` verify the foundation. The tests use Fastify injection and a stubbed readiness probe.

| Route | Purpose |
| --- | --- |
| `GET /` | Existing hello endpoint |
| `GET /api/v1/ping?name=Magpet` | Versioned request and response example |
| `GET /health/live` | Process liveness independent of PostgreSQL |
| `GET /health/ready` | Bounded database probe, returning `503` on failure |
| `GET /openapi.json` | OpenAPI generated from registered route schemas |

API errors use an `error` object with `code`, `message`, and `requestId`. Request IDs correlate responses with structured server logs. Startup can complete during a database outage so readiness can recover when PostgreSQL returns.

See [device enrollment and session persistence](docs/device-enrollment.md) for the internal service contract, initial administrator bootstrap plan, and PostgreSQL test setup.

## Contributing

1. Create a feature branch.
2. Make focused changes and add or update tests where appropriate.
3. Open a pull request with a short summary of the change and verification steps.

## License

[Add the project license information here.]
