# E-BDRMS Backend Engineering Guidelines

## Project context

E-BDRMS (Electronic Budget Document and Records Management System) is a custom, office-level document and records management application for the Municipal Budget Office of Magpet. This repository contains its **Fastify + TypeScript REST API**; a separate client (likely React Native) consumes the API. PostgreSQL is the authoritative database and Drizzle is the ORM/migration tool. The v1 scope is the Budget Office, not an LGU-wide platform.

The system manages master document templates, template versions, generated documents, immutable revisions, signatory records, structured financial figures, RBAC, audit events, and PDF output. It is not a general accounting or payment-processing system.

## Working principles

1. **Context efficiency:** Inspect only files needed for the task. Avoid whole-repository reads, repeated unchanged-file inspection, and speculative research.
2. **Focused execution:** Implement the requested stage only. No unrelated refactors, optional packages, frameworks, or speculative features.
3. **Consistency:** Preserve existing naming, architecture, and dependencies unless change is necessary and justified.
4. **Communication:** Be concise and technical; explain significant trade-offs, blockers, and assumptions, not routine commands.
5. **Judgment:** Make safe minor assumptions; ask before irreversible, security-critical, or product-defining changes that cannot reasonably be inferred.
6. **Verification:** Run focused checks and tests. Never claim unrun tests passed. Report commands and outcomes.
7. **Scope control:** Preserve unrelated code and behavior. Do not modify client repositories or production resources without authorization.
8. **Completion:** Finish each stage with changed files, decisions, verification, and remaining risks.
9. **Security first:** Never trade off authorization, data integrity, secret safety, or auditability for shorter code.

## Architectural boundaries

- Use a **modular monolith**: one deployable Fastify API with domain modules, not microservices.
- Prefer modules such as `auth`, `devices`, `users`, `roles`, `offices`, `document-types`, `templates`, `documents`, `signatories`, `reports`, and `audit`.
- Within a module, separate routes/request schemas, application services, and Drizzle persistence only when warranted. Avoid boilerplate-only abstractions.
- Keep business rules, authentication, authorization, and PDF rendering on the server. The React Native client is untrusted and must never connect directly to PostgreSQL.
- Use versioned REST routes (`/api/v1`), consistent error responses, schema-based input/output validation, and OpenAPI documentation where supported by the current stack.
- Validate runtime configuration at startup for development, test, and production. Never commit secrets; do not log passwords, device credentials, JWTs, or refresh tokens.
- Prefer mature Fastify plugins and existing packages to custom implementations. Verify dependency compatibility with installed versions before adding packages.

## Database and domain rules

- The checked-in Drizzle schema and migration history are the source of truth. Inspect the actual schema before assuming table/column names.
- Use `drizzle-kit generate` and reviewed `migrate` migrations for shared environments; do not run `push` against staging/production.
- Never drop tables, reset data, modify migration history, or run destructive migrations without explicit approval and a recovery plan.
- Preserve distinct concepts: template, immutable template version, document identity, immutable document revision, and the managing office (metadata, not an implicit access grant).
- Track creator and revision authorship. Signatories are independent records and are not required to be users.
- Use transactions for document revisions, associated reportable financial values, and audit metadata. Prevent lost updates using expected revision/version checks.
- Keep variable form schemas/values in validated JSONB when appropriate; store reportable monetary amounts as exact `numeric` values or equivalent precise strings at API boundaries.
- Never silently re-render historical documents against a newer template version. Finalization/archiving rules must preserve history.
- Enforce foreign keys, unique constraints, and indexes where domain rules require them. Use UTC instants for event timestamps.

## Device registration, authentication, and RBAC

- **Devices are an authentication gate; RBAC is the authorization model.** A device does not inherit permissions by having a device ID. Resolve effective permissions from the user and applicable document-type rules.
- Model approved user-device registrations separately from login sessions and refresh-token rotation records, if the existing schema does not already support those responsibilities.
- Define a controlled enrollment process: authenticated enrollment request, pending/approved/revoked states, and administrator approval (plus a documented secure bootstrap procedure). Do not silently auto-approve arbitrary new devices.
- Generate unpredictable per-installation credentials, store only their cryptographic hashes/server-side verifiers, and store client secrets using the operating system's secure credential storage. Verify proof of the enrolled device credential during login **and refresh**, not merely a submitted device ID. Never treat caller-supplied IDs or labels as proof of possession.
- A copied bearer credential can be replayed: v1 device enrollment is **software-bound**, not a guarantee of physical hardware binding. If strict physical binding is required, design explicit cryptographic proof-of-possession using an OS-protected private key and challenge/request signing; do not claim hardware attestation without implementing it.
- Issue short-lived signed access JWTs (target ~10–15 minutes) with validated issuer, audience, expiry, token type, subject (`sub`), session ID (`sid`), device ID (`did`), and `jti`; allow key rotation. Do not embed mutable role grants as the sole authority.
- Refresh tokens must be high-entropy, single-use, rotated on refresh, hashed at rest, bounded by expiration, and linked to a user/device/session. **Opaque refresh tokens are preferred**; if JWT refresh tokens are explicitly required, persist and validate their unique IDs/hashes and rotation/revocation state. A self-contained refresh JWT alone is insufficient.
- Refresh rotation must be atomic; handle concurrent refreshes and replay/reuse by revoking the affected token family/session. Logout, password reset, device revocation, user disablement, and role changes must have defined invalidation semantics.
- For every protected request, verify the access JWT and current user/session/device status; then enforce relevant permission and record-level checks. A revoked device/session must be denied without waiting for access-token expiry.
- Apply rate limits to authentication/device endpoints, generic login failures, audit security events, and HTTPS in deployed environments. Never expose tokens in URLs, logs, or analytics.
- Tests must cover pending/revoked devices, token replay, expired tokens, logout, cross-user device reuse, role denial, and concurrent refresh behavior.

## Document templates and PDF security

- Treat **Eta source as executable trusted code**. Never compile or render arbitrary user-submitted Eta/JavaScript, and never assume HTML escaping makes untrusted template source safe.
- The v1 application may select only reviewed, approved template versions. New executable template source must go through a trusted code-review/deployment process, not ordinary document editing endpoints.
- Ordinary users submit structured field values only; validate them against the selected immutable template version (types, allowed keys, lengths, repetitions, required fields, and numerical limits).
- Escape data in the correct output context. Disallow raw HTML/JS from document fields; do not allow user-controlled paths, template includes, arbitrary asset URLs, or dynamic resource names.
- Render PDFs on the server using tightly controlled Eta + Playwright. Disable page JavaScript when not required; block external network/file requests and use vetted local or embedded assets. Restrict Chromium process permissions and concurrent render count.
- Render from a stored document revision and its specific template version. Set output type, content disposition, size/time limits, and stable PDF settings.
- Audit document creation, revision, finalization, template publication, PDF export where required, and changes to access rights.

## Deployment, backup, and recovery

- Provide reproducible Docker images and a simple Docker Compose deployment (API and PostgreSQL; proxy/backup task when needed). A native development workflow remains supported.
- Use pinned image versions, health/readiness checks, restart policies, non-root application execution, appropriate network isolation, and persistent volumes. Do not publish PostgreSQL publicly by default.
- Keep database credentials/signing keys out of source and images; use deployment-provided secrets or protected environment files, with documented rotation.
- Implement automated scheduled PostgreSQL backups (`pg_dump` custom format or a documented equivalent), encrypted/protected storage outside the primary database volume, retention, monitoring/alerts on failure, and periodic **test restores** to a disposable database.
- Back up required document assets/uploads and configuration separately if they are stored outside PostgreSQL. Container images and database volumes are **not backups**.
- Deployment procedure: preflight -> verified pre-deploy backup -> reviewed migrations -> release -> smoke tests. Document application image rollback and database recovery **separately**.
- Never automatically reverse destructive schema migrations or restore an older database over live data. Prefer backward-compatible migrations; a database restore requires an explicit recovery decision and downtime plan.
- Keep restore and rollback commands safe by default (dry-run/confirmation, target checks); never use `docker compose down -v` in an operational recovery script.

## Stage completion requirements

For each requested implementation stage:

1. Inspect only the relevant repository files and existing contracts.
2. Briefly state the minimal plan and any meaningful decision.
3. Implement the requested stage with targeted tests and documentation.
4. Run available focused lint/typecheck/tests/migration validation; do not use production data for tests.
5. Report: changes, commands and results, assumptions, and next-stage prerequisites. Stop rather than silently expanding the scope.
