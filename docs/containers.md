# Container development and deployment

See the [backup and recovery runbook](recovery.md) for scheduled backups, disposable restore tests, guarded releases, and application-image rollback.

The multi-stage image builds the TypeScript API with the pinned pnpm version and frozen lockfile, then installs production dependencies separately. The final image runs as Node's `node` user. The Node and PostgreSQL bases are pinned by digest. Playwright installs its locked Chromium headless shell and the corresponding Debian runtime libraries and system fonts during build. Debian packages come from the Bookworm repositories at build time. Promote the built API image by digest when deploying the same runtime across environments.

The image contains the reviewed Eta sources, print CSS, and vetted municipal logo under `/app/templates`, plus the reviewed migrations. The forms use the container's system fonts. Historical immutable template snapshots and their embedded assets live in PostgreSQL. The renderer compiles Tailwind locally from those inputs or from the packaged reporting template.

## Environment

Use a Docker Engine with BuildKit and Docker Compose 2.30 or newer. Use a host that supports the Chromium unprivileged user-namespace sandbox. Compose uses an init process, private shared memory, and a profile based on the [Playwright v1.65.1 seccomp profile](https://github.com/microsoft/playwright/blob/v1.65.1/utils/docker/seccomp_profile.json). The local profile drops the Docker capability condition on the `chroot` syscall so Chromium can enter its own sandbox after creating a user namespace. The kernel still enforces the capability check in that namespace, and all container capabilities remain dropped. Keep the runtime browser sandbox enabled.

Upstream [license](../docker/chromium-seccomp.LICENSE) and [notice](../docker/chromium-seccomp.NOTICE) are included with the profile.

For a new local environment, create protected files from the examples and fill in distinct database passwords and a random 32-byte base64url JWT signing key. Compose reads these values literally. URL-encode password characters in `DATABASE_URL` if necessary. Use separate files and a separate Compose project name for each environment.

```bash
umask 077
cp docker/compose-api.env.example .env.compose.api
cp docker/compose-db.env.example .env.compose.db
cp docker/compose-maintenance.env.example .env.compose.maintenance
```

Set `EBDRMS_API_ENV_FILE`, `EBDRMS_DB_ENV_FILE`, and `EBDRMS_MAINTENANCE_ENV_FILE` to use environment-specific file paths. Place secret files outside version control and restrict access to the Docker daemon. The API defaults to production configuration at `127.0.0.1:3000`. Override `EBDRMS_API_PORT` for local instances, set `EBDRMS_NODE_ENV=development` for development behavior, and set `EBDRMS_API_IMAGE` when using a separately built image. Use an HTTPS reverse proxy for deployed access. PostgreSQL joins only the private backend network and stores data in the named `postgres-data` volume at the PostgreSQL 18 volume root.

## Build, migrate, and start

```bash
docker compose config --quiet
docker compose build api
docker compose up -d --wait db
docker compose run --rm migrate
```

The maintenance service applies the checked-in migrations explicitly. Keep its database credentials separate from the API's credentials. For a new database with the example account names, open an interactive owner session:

```bash
docker compose exec db psql -U ebdrms_owner -d ebdrms -v ON_ERROR_STOP=1
```

Create the runtime role and set its password at the prompt. Use the same password in the API environment file. Adapt these grants to existing role names when upgrading an environment.

```sql
CREATE ROLE ebdrms_api LOGIN;
\password ebdrms_api
GRANT CONNECT ON DATABASE ebdrms TO ebdrms_api;
GRANT USAGE ON SCHEMA public TO ebdrms_api;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ebdrms_api;
GRANT INSERT, UPDATE ON user_devices, auth_sessions, refresh_tokens TO ebdrms_api;
GRANT INSERT ON activity_logs, auth_logs, documents, document_revisions,
  document_revision_signatories, document_financial_values TO ebdrms_api;
GRANT UPDATE (status, updated_at) ON documents TO ebdrms_api;
GRANT UPDATE (is_active, updated_at) ON users TO ebdrms_api;
GRANT UPDATE (updated_at) ON document_templates, document_types TO ebdrms_api;
GRANT INSERT, DELETE ON user_roles, role_permissions, role_document_type_permissions TO ebdrms_api;
```

The narrow timestamp grant on template and type records lets document creation take PostgreSQL row locks while it pins the published version. For an existing shared environment, follow preflight, verified backup, reviewed migration, release, and smoke checks in that order. Apply changes to the runtime grants when a reviewed migration adds a table the API needs. The documented administrator bootstrap and reviewed `publish-cli.js` remain maintenance operations. Use `docker compose run --rm migrate node dist/templates/publish-cli.js inspect CAFOA` to inspect a packaged template digest.

```bash
docker compose up -d --wait api
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
```

For a prebuilt release, set `EBDRMS_API_IMAGE` to the release digest, pull that image before running maintenance, and use `docker compose up -d --wait --no-build api`.

`docker compose down` stops the stack and retains its named database volume. A database volume is separate from the backup and recovery process. Native development continues to use `pnpm dev`, local PostgreSQL, and `pnpm exec drizzle-kit migrate`.

## Isolated PDF smoke test

Run from the repository root after building. This starts the image with networking disabled and runs from a different working directory. It renders all six form layouts and the dashboard from the image's compiled code and packaged assets. It requires neither PostgreSQL nor fixture data in the image.

```bash
docker run --rm -i --init --network none --workdir /tmp --shm-size 256m \
  --cap-drop ALL --security-opt no-new-privileges=true \
  --security-opt seccomp=docker/chromium-seccomp.json \
  "${EBDRMS_API_IMAGE:-mbo-ebdrms-api:local}" \
  node --input-type=module < docker/smoke-pdf.mjs
```
