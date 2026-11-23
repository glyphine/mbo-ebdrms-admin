# Trusted template publication

The registry defines CAFOA, the four RAAO forms, and SAAOB. It contains the form schemas and permitted repository filenames. The four RAAO wrappers share `_raao.eta` and default to landscape. Other forms default to portrait. Every form starts with A4 paper and 12 mm margins.

## Review and publish

Review the registry definition, the Eta layout and any shared partial, CSS under `templates/print`, and the vetted asset files. Treat Eta files as executable server code. Review the release checkout and approve the digest from that exact checkout. For example:

```bash
pnpm templates inspect CAFOA
pnpm templates publish CAFOA <operator-user-uuid> <approved-sha256>
```

Run publication from a trusted deployment or maintenance environment with a database identity authorized to insert template versions and publication audit events. Give the API database identity read access to published template data. The command verifies the supplied digest, uses an active operator account for attribution, and records publication in the same transaction as the version. Identical retries return the current version. Changes append a new version, including when publishing previously used content after an intervening version.

The version stores the root Eta source, recursive schema, PDF options, and a render snapshot. The snapshot includes the shared partial contents where applicable, print stylesheet names and contents, the intended Eta and Tailwind versions, and vetted logo bytes with their source file and hash. The digest covers the complete render input and remains stable across PostgreSQL JSONB key ordering. Logo changes require reviewing the new bytes and updating the approved asset digest in source.

The additive migration preserves older rows and makes template versions append-only. Legacy versions without reviewed provenance are excluded from published metadata and from the internal verified-version loader. New publication leaves historical references pinned to their original version IDs. The next document and rendering stages should load the exact version by ID and use its contents, including its saved partials and assets. Use escaped Eta interpolation, load partials from that snapshot, and use the snapshotted Tailwind and print CSS inputs.

## API and form values

`GET /api/v1/templates` lists the latest accessible published version of each active template. `GET /api/v1/templates/:templateId/versions/:versionNumber` returns the selected version's schema and PDF defaults. Type-scoped `documents.read` can retrieve historical versions. `documents.create` permits access to the latest active version for that type. HTTP responses contain form metadata. Publication takes place through the maintenance command.

The shape validator accepts partial draft values, preserves the difference between absent fields, explicit `null`, and empty arrays, and rejects unknown keys at every level. CAFOA and RAAO allow null spacer rows. RAAO detail rows permit up to eight nullable money cells. SAAOB office, category, and entry rows must be objects, with optional nested arrays and totals. Money values are strings that fit PostgreSQL `numeric(18,2)`, with up to 16 integer digits and two fractional digits. CAFOA and RAAO transaction dates use `YYYY-MM-DD`. SAAOB period headings are bounded display text.

The validator enforces per-field limits, a nesting depth of 12, at most 20,000 values, and at most 256 KiB of aggregate string content. Treat valid markup-like text as plain text and escape it at Eta interpolation. Asset paths, styles, PDF configuration, and executable template content are controlled by publication.
