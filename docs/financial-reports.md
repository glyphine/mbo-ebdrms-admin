# Financial reporting and audit API

The dashboard reads one explicitly selected SAAOB document's current finalized revision. A finalized or archived document qualifies when its head revision is finalized and points to a trusted publication. Selecting a single source keeps cumulative statements and their historical revisions from being added together. CAFOA and RAAO projections represent overlapping financial activity and are excluded from this report. Report queries leave official documents and revisions intact.

## Routes and permissions

| Route | Required permissions | Response |
| --- | --- | --- |
| `GET /api/v1/reports/financial/sources` | Global `reports.read` and `documents.read` for SAAOB | Available source IDs, head revisions, and known coverage. Filters include `fiscalYear`. Use `limit` and `after` with `nextAfter` to paginate. |
| `POST /api/v1/reports/financial` | Same as source listing | Metric cards, available office and category filters, one breakdown page, and chart data. |
| `POST /api/v1/reports/financial/pdf` | Same as the query, plus global `reports.export` | Private PDF attachment rendered from the same query and data snapshot. |
| `GET /api/v1/audit/events` | Global `audit.read` | Paginated operational or authentication audit events across the application. |

Provision these global grants through trusted role provisioning. The SAAOB read grant can be global or scoped to SAAOB. Each route requires a live bearer session. Source and audit pages allow up to 50 items, with route rate limits and a four-second database statement timeout.

## Dashboard query

Send a JSON body with `sourceDocumentId`. Optional fields are:

- `fiscalYear`, `fromDate`, and `toDate`. A date range must cover the entire recorded interval. A partial overlap yields `periodMatched: false` and missing amounts. A date-filtered query returns `422` if the source lacks a complete ISO `YYYY-MM-DD` interval. The fiscal year and coverage are read independently from their stored fields. The service does not convert free-text dates, prorate a statement, or guess fiscal coverage.
- `officeIds` and `categories`, each with up to 20 selections. `null` selects unassigned offices or uncategorized entries. Office IDs come from typed financial projections. The office registry supplies current display labels. The managing office does not affect the report. Categories come from the saved entry's category label and match exactly after trimming.
- `metrics`, in display order, selected from `appropriations`, `allotment`, `obligation`, `appropriationBalance`, and `balance`. The defaults include all five. Amounts are decimal strings in PHP. A missing amount is `null`, and an observed zero is `"0.00"`.
- `groupBy` as `office`, `category`, or `officeCategory`. `limit` and `offset` page the breakdown, up to 50 rows per page. The chart uses the first 12 groups in stable label order before breakdown pagination and reports how many groups it omits. Totals use the entire selection. Neither dataset depends on a client charting package.

The report sums typed entry projections with exact PostgreSQL numeric arithmetic and integer cents. It excludes category, office, and grand totals and accepts only the matching SAAOB detail-entry paths. Source selection, office labels, and amounts are read in one repeatable-read transaction. The existing financial revision-path index supports the bounded per-revision query. A partial template and ID index supports the finalized-source picker.

The PDF endpoint accepts the same selection and an optional `expectedSnapshotId` from the JSON response. A mismatch returns `409` before rendering. The PDF carries `X-Report-Snapshot` and prints the same source revision, period, filters, metrics, chart points, and breakdown page. It uses the dedicated reviewed `templates/financial-report.eta` layout and shares the existing sandboxed render pool. The export accepts structured selection data only.

## Audit events

`GET /api/v1/audit/events` accepts `stream=activity` or `stream=authentication`, with optional `actorUserId`, `targetType`, `targetId`, `action`, `fromDate`, and `toDate`. Date filters use inclusive UTC calendar dates. Results are newest first. Pass `nextAfter` back as `after` for the same stream. The cursor retains PostgreSQL microseconds and uses the event ID to break timestamp ties.

Each event exposes its ID, actor, target type and ID, action, and UTC timestamp. Denied or unauthenticated attempts have no verified actor. Older authentication events can identify the affected user when the log has a user ID. New session events capture the specific session or device. Responses omit messages, internal metadata, network identifiers, and credentials.

Successful report queries, PDF exports, and audit reads append activity events. Report audit records identify the source revision and snapshot hash. Application audit access consists of append operations and authorized reads. The migration adds nullable auth target fields and indexed timestamp/ID cursors while preserving existing event rows.
