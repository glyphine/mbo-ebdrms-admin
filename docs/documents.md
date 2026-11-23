# Documents and revision history

Every route under `/api/v1/documents` requires an active bearer session and the corresponding global or document-type grant. The API uses `managingOfficeId` as metadata. User and office IDs do not confer document access.

| Method and path | Permission | Behavior |
| --- | --- | --- |
| `POST /` | `documents.create` | Creates an identity and draft revision 1 from the selected current published `templateVersionId`. |
| `GET /` | `documents.read` | Lists readable identities. Use `?after=<documentId>` for the next page. |
| `GET /:documentId` | `documents.read` | Returns identity metadata and the current revision number. |
| `GET /:documentId/revisions` | `documents.read` | Lists revision metadata. Use `?after=<revisionNumber>` for the next page. |
| `GET /:documentId/revisions/:revisionNumber` | `documents.read` | Returns the exact revision, its values, signatory snapshots, and `templateVersionId`. |
| `POST /:documentId/revisions` | `documents.revise` | Appends a draft from replacement `values`. |
| `POST /:documentId/finalize` | `documents.finalize` | Appends a finalized revision from the current draft, including its saved signatories and financial projections. |
| `POST /:documentId/archive` | `documents.archive` | Archives a finalized document and keeps its finalized revision as the head. |

Create requires `title`, `templateVersionId`, and `values`. Optional metadata includes `description`, `referenceNumber`, `fiscalYear`, `managingOfficeId`, and `changeNote`. Revise, finalize, and archive require `expectedRevision`. If publication or a concurrent edit made the caller's selection stale, the API returns `409`. Refresh the metadata and decide whether to resubmit. Lists return up to 50 rows. Archived documents retain their regular read rules. The legacy `voided` state also remains readable with its existing grant.

Values are validated with the exact published schema pinned at creation. The API appends revisions while a document is draft. Finalization checks the pinned draft structure and freezes it. Finalized and archived documents are closed to further edits. This stage permits partial drafts and applies structural validation at finalization. Document-specific approval and completeness rules require separately approved business policy.

## Server-owned values

Use `signatories` to supply an array of `{slotKey, signatoryId, date?}`. CAFOA slots are `official` and `signatory1` through `signatory3`. CAFOA allows an optional `YYYY-MM-DD` date. SAAOB slots are `preparedBy` and `certifiedBy`. RAAO has no signatory slots in its layout. The IDs refer to the separate signatory registry. A revision copies the registered display name and designation. Omit `signatories` on an edit to keep the previous snapshots, or supply a replacement array. `[]` clears the selections.

Submit the financial inputs as exact decimal strings. The service derives these values with integer cents:

- CAFOA requested amount sums the detail amounts and derives its English peso and centavo text. `approvedAmount` is a separate input. The running ledger balance starts at zero and accumulates obligation increases minus liquidations in row order.
- RAAO row totals sum the nonblank detail cells.
- SAAOB entry balances use appropriation minus allotment and allotment minus obligation when both terms are supplied. Category, office, and grand totals sum the available amounts per metric. A supplied SAAOB office code must exist in the office registry. A blank or omitted code leaves the projection unassigned to an office.

Send the editable source fields when replacing `values`. The response also includes computed fields and snapshotted signatory labels for display. Omit those fields from edit requests. Missing values, nullable amounts, and spacer rows retain their layout meaning. Paths, assets, source, styles, and PDF settings come from the published template.

The revision, signatory snapshot rows, financial projections, and audit event commit together. Projections carry a revision-specific field path and an aggregate flag so parent totals can be excluded from detail-only reports. The migration adds the archived enum value and append-only triggers. An insert trigger enforces the parent template and pinned version for new revisions. Existing historical rows are retained. A legacy document without a verified head cannot advance through the write API.
