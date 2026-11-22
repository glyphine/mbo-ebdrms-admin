# E-BDRMS: staged Codex implementation prompts

Use these prompts **one stage at a time**, in order. Place `AGENTS.md` at the API repository root first. Each stage assumes the previous accepted stage has been committed. Do not blindly run commands against a database containing important records. These prompts intentionally allow Codex to inspect actual schema and versions instead of guessing.

## Stage 0 — Repository audit and implementation map (no code changes)

> Read `AGENTS.md`, `package.json`, Fastify bootstrap files, Drizzle schema/config and migrations, existing tests, and document-renderer integration points only. Summarize the current architecture and produce a minimal implementation map for the requested device-gated auth, RBAC, trusted document rendering, backups, and Docker Compose deployment. Identify missing DB tables/constraints and exact migration risks. Propose API endpoints and stage dependencies. Do not edit files, install packages, or touch databases. Return a concise list of decisions that materially require my approval.

## Stage 1 — Fastify foundation and API contract

> Follow `AGENTS.md`. Implement or normalize the smallest viable Fastify modular-monolith foundation using existing conventions: `app.ts`/`server.ts` separation, validated configuration, database lifecycle, unified errors, request schemas, `/api/v1` routing, `/health/live` and `/health/ready`, structured redacted logging, and OpenAPI generation if compatible with the installed stack. Do not add auth behavior or modify business tables yet. Add focused tests for startup, validation, health/readiness, and error formatting. Run typecheck and relevant tests; report what changed.

## Stage 2 — Device/session persistence and safe enrollment

> Follow `AGENTS.md` and inspect the actual Drizzle schema/migrations. Implement the minimum persistent models for user-bound devices, login sessions, and refresh-token rotation/history (reuse existing tables if appropriate). Use constraints and indexes. Build enrollment/revocation **service logic** with pending/approved/revoked states and a restricted initial-admin bootstrap plan; registration must not grant access by itself. Defer public enrollment/approval routes until authentication and RBAC guard them in Stages 3–4. Never store raw device credentials or refresh tokens. Add a reviewed non-destructive migration and tests for enrollment states and cross-user misuse. Explain the software-bound device security limit. Do not implement JWT endpoints yet.

## Stage 3 — Authentication and token lifecycle

> Follow `AGENTS.md`. Implement password verification, pending device enrollment requests after credential verification, approved-device login, **device credential proof on login and refresh**, short-lived access JWT, single-use rotating refresh tokens, logout, per-device session revocation, and middleware that rejects invalid/disabled user, device, or session state. Use atomic refresh rotation and reuse detection. Prefer opaque refresh tokens unless the repository already establishes a justified JWT refresh contract; access JWTs must validate issuer/audience/type/expiry and carry `sub`, `sid`, `did`, and `jti`. Rate-limit sensitive endpoints; redact secrets. Preserve a clear path for the React Native client to store credentials in OS secure storage. Add focused tests covering expired/replayed tokens, race conditions, revoked devices, and logout. Do not implement RBAC business endpoints in this stage.

## Stage 4 — RBAC and document-type access control

> Follow `AGENTS.md`. Implement reusable authorization guards using existing user-role, role-permission, and document-type permissions tables. Devices determine whether a session is allowed, but roles determine what it can do. Apply deny-by-default and document record-level status rules; `managingOfficeId` is metadata unless a specific office-scoping policy exists. Add authenticated administrator endpoints for pending-device approval/revocation plus narrowly scoped role/user management, with audit events for permission changes. Test denied access, revoked sessions, stale tokens, and document-type grants. Do not introduce per-device role assignments without a concrete requirement.

## Stage 5 — Trusted templates and document definitions

> Follow `AGENTS.md`. Build document-type and template version listing/retrieval using the current Drizzle schema. Templates include immutable field schema, reviewed Eta source/reference, PDF settings, and publication status. Provide an approval/publish workflow that **does not** permit ordinary API users to submit executable Eta source. Validate the dynamic field schema and reject unknown fields, unsafe resource identifiers, raw HTML, and unsupported asset paths. Preserve exact template-version references. Add tests for trusted/untrusted template boundaries; do not build a general-purpose user-code editor.

## Stage 6 — Documents and immutable revisions

> Follow `AGENTS.md`. Implement create/read/list and revision APIs for documents, using immutable revisions tied to exact template versions, `createdBy`, `managingOfficeId` metadata, and non-account signatory snapshots. Define draft/finalized/archived transitions and enforce them in services. Use optimistic concurrency (expected revision/version) to prevent lost updates, and wrap revision data, typed financial projections, and audit events in transactions. Test concurrent edits, finalization rules, history, and user permissions. Do not overwrite finalized history or silently upgrade templates.

## Stage 7 — Secure PDF generation

> Follow `AGENTS.md`. Integrate existing Eta/Tailwind/Playwright renderer behind a document PDF service. Render only reviewed template versions with validated stored revision values. Do not accept raw Eta or arbitrary HTML from clients. Escape field values, disable browser-side JavaScript where possible, block network and file access, allow only vetted local/embedded assets, cap render concurrency/duration, and cleanly dispose of Chromium pages. Serve PDFs with correct headers and no secret leakage. Add tests for injection attempts, remote-resource access, output correctness, revision/template fidelity, and missing assets. Avoid adding a queue unless load testing warrants one.

## Stage 8 — Reporting, auditing, and operational API safeguards

> Follow `AGENTS.md`. Implement scoped reporting endpoints on exact, approved financial values, including office codes, fiscal periods, and correct current/finalized-revision selection; avoid double-counting aggregate SAAOB rows and detailed lines. Implement audit event recording/retrieval with actor, target, action, and timestamp, enforcing append-only application semantics. Add pagination, limits, indexes where evidenced, and RBAC checks. Test cross-office aggregates, revision selection, unauthorized access, and audit completeness. Avoid adding analytics platforms or a separate reporting database.

## Stage 9 — Containerized development and production deployment

> Follow `AGENTS.md`. Add a minimal multi-stage API Dockerfile (including required Playwright Chromium dependencies), `.dockerignore`, Docker Compose setup for API + PostgreSQL with persistent DB data, healthchecks, internal DB networking, and environment-specific configuration. Keep a native local-development option and add separate development/production examples as justified. Pin compatible images; run application process non-root; keep credentials out of git and image layers. Document reproducible build, initial migrations, and smoke tests. Validate Compose configuration and startup using available tools. Do not deploy to a real server.

## Stage 10 — Database backups, test restores, and release rollback

> Follow `AGENTS.md`. Add scheduled PostgreSQL backups in custom format with protected storage outside the DB volume, retention, status logging, and failure reporting. Implement a **non-destructive** test-restore procedure to a throwaway database and document how assets outside PostgreSQL are backed up. Create deployment and application-image rollback scripts with explicit confirmation, pre-deploy backup verification, health checks, and backward-compatible migration expectations. Do not automate database downgrade or restore over live records. Add a simulated recovery test and document recovery limits (RPO/RTO assumptions) and operator actions.

## Stage 11 — Acceptance and handover hardening

> Follow `AGENTS.md`. Perform a targeted end-to-end review of the API contract against the client integration needs and core E-BDRMS workflows. Add a short operator runbook and minimal API integration examples: approve a device, log in, rotate tokens, create and revise a document, generate PDF, revoke a device, take and verify a backup. Audit open critical risks and tests without performing broad refactors. Run the available suite and report actual results, outstanding failures, and production blockers. Do not claim production readiness without verified restore, auth-revocation, and template-injection checks.

## How to use the prompts

- Start a new Codex instruction with the next stage verbatim, or paste the stage section.
- Review the diff and tests after every stage; commit accepted work before proceeding.
- If Codex needs to change the agreed data model or security guarantees, require it to state the trade-off before proceeding.
- Build the React Native client against the resulting OpenAPI contract in a **separate repository/stage sequence**, not in these backend stages.
