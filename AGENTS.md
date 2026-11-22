# E-BDRMS Backend Engineering Guidelines

## Project context

E-BDRMS (Electronic Budget Document and Records Management System) is a custom, office-level document and records management application for the Municipal Budget Office of Magpet. This repository contains its **Fastify + TypeScript REST API**; a separate React Native client consumes the API. PostgreSQL is the authoritative database and Drizzle is the ORM/migration tool. The v1 scope is the Budget Office, not an LGU-wide platform.

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

## Document definitions, trusted `.eta` templates, and PDF generation

**Reference implementation:** The supplied `index.ts` defines `DocValue`, recursive `DocField`, `DocEntry`, `PdfOptions`, and the Eta → `@tailwindcss/node` → Playwright pipeline. Its `test_data.ts` provides **fixtures only**. Port/adapt this design to the server; do not make tests or fixtures a runtime dependency, and do not force a new document engine.

- Maintain reviewed template files under repository-root `templates/`: `cafoa.eta`, `raaoco.eta`, `raaofe.eta`, `raaomooe.eta`, `raaops.eta`, and `saaob.eta`. Keep logos, fonts, and other vetted print assets under a controlled assets directory (e.g. `templates/assets/`); reconcile existing `doc_templates/` assets rather than assuming they have moved. All paths are **server-controlled**, never constructed from client input.
- Preserve document-type definitions and layouts from the reference: CAFOA details and ledgers; the four RAAO forms' shared registry field structure, `budgetRows` and `actualRows`; and SAAOB's nested offices → categories → entries, category/office/grand totals. Preserve supported PDF sizes, margins, orientation (RAAO defaults to landscape), and vetted print-specific CSS. Keep rendering definitions reusable rather than duplicating RAAO logic.
- Treat each `DocEntry` as a **definition**, not a client-authored render job. Validate the submitted JSON against a **published, versioned recursive field schema**, including nested objects/arrays, numeric formats, optional/null print-row placeholders, known field keys, length/row/depth limits, and the distinction between absent fields and blank placeholders. Translate stored revision values into Eta's flat top-level data object using the *definition's* field keys, not arbitrary client-controlled property names. Never accept `resource`, `pdfOptions`, HTML, Eta source, CSS, or asset paths from ordinary document requests.
- Keep financial values as exact decimal strings or PostgreSQL `numeric` for calculation/storage; use approved formatting functions for display. The fixtures' `Number` arithmetic and hard-coded names, office codes, and account codes are illustrative **test data**, not official registries or production business logic.
- **Trust boundary:** Eta templates execute JavaScript on the **Node.js server**. Only maintainers' code-reviewed `.eta` files may be published. Do not offer an API that compiles arbitrary Eta/JS, and do not treat an admin approval click as a sandbox for executable source. Use escaped interpolation (`<%=`) for ordinary textual values; prohibit untrusted raw output (`<%~`), arbitrary includes, HTML fragments, CSS values, or URLs; markup-like *text* in a legitimate plain-text field must remain inert rather than execute. Review any exceptional intentional raw markup generated solely by trusted server code. Browser-side JavaScript restrictions **do not** sandbox server-side Eta execution.
- **Template publication and history:** Maintain template source in Git under `templates/`, but when publishing a version preserve an **immutable snapshot** (Eta source or immutable release artifact with verified digest, recursive field schema, PDF options, stylesheet/assets provenance and version/hash) in the database or durable, version-addressed storage referenced by the database. Prefer the existing template-version schema; extend minimally only if needed. Published versions cannot be silently replaced or repointed. Render old document revisions against their original trusted template snapshot, never whichever `.eta` file is currently deployed. If exact originally-issued appearance is required, retain the issued PDF artifact as well and include it in backup scope.
- **Render pipeline:** (1) authorize access to an immutable document revision; (2) load its exact approved template version and validate the saved values; (3) resolve vetted/embed-only assets such as the municipal logo (e.g. `data:image/png;base64,...`); (4) render Eta to HTML; (5) compile/build Tailwind CSS from trusted template markup/styles using the installed compatible `@tailwindcss/node` API, plus reviewed print CSS; (6) render with Playwright Chromium to a PDF buffer/stream; (7) dispose of page/context and return `application/pdf` with suitable `Content-Disposition` and caching/privacy headers. Keep templates and compiled CSS outside user control.
- **Renderer safety:** Prefer compiling/caching CSS per template version instead of rescanning/recompiling on every document. Do not rely on regex removal of a CDN `<script>` tag or on regex class discovery as a general security boundary; avoid CDN scripts entirely and test any candidate extraction approach against actual templates. Use a restricted Playwright context with browser page JavaScript disabled unless absolutely necessary, deny all external HTTP(S)/file requests (allow only vetted embedded/local content), set deadlines/size and concurrency limits, and release contexts even on failure. Reuse a carefully managed browser process rather than launching Chromium per request if throughput requires it. Do not disable the Chromium sandbox simply to make containers work; review the installed Playwright container guidance.
- Keep `test_data.ts`-style scenarios as fixture factories, including multiple amounts/rows, `null` spacer rows, nested SAAOB totals, logo embedding, and different paper orientations. Add actual PDF smoke/golden-layout tests plus adversarial cases: HTML/Eta-like text in fields, attempted remote assets, unsafe paths, wrong schema/version, missing assets, unexpectedly deep/large arrays, timeouts, and concurrent render cleanup.
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
