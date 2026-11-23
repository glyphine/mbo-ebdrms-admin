# Operator runbook

Use an approved HTTPS environment and a known administrator device. Check `/health/live` and `/health/ready`. In a new environment, complete the [restricted first-administrator bootstrap](device-enrollment.md#initial-administrator-bootstrap-plan) and [reviewed template publication](template-publication.md) before onboarding staff. The [API examples](api-examples.md) show each request and its expected response.

1. **Approve a device.** Have the employee enroll from the installation they will use. Match the account and pending device ID through a separate channel before approving. Verify a login from that device and assign only the roles needed for the employee's work.
2. **Create or revise a form.** Select a published version for the exact form code. Enter structured values, use provisioned signatory IDs where supported, and review the derived totals. Check the returned revision number. Resolve a stale `409` by reloading the record and reconciling changes before resubmitting. Finalize only after the office approves the document content and fund code. Record the server-assigned serial number.
3. **Print or reprint.** Download the exact revision with an authenticated request. Check its filename, orientation, logo, headings, totals, and signature blocks in the print preview. Use the PDF's paper size and orientation and print at actual size when the printer supports the saved margins. For an issued document, record its document ID and revision. Retain issued bytes in protected storage if the office requires identical reprints.
4. **Revoke a lost or retired device.** Confirm the target account and device ID, revoke enrollment, then verify a previously issued access token fails on `/auth/me` and that refresh fails. Check the audit event. A replacement installation needs fresh enrollment and approval. Handle any previously exported copies under the office's document-handling policy.
5. **Take and verify a backup.** From the Compose host using the operations account and exported settings, run the following. Use the backup ID printed by the first command. Record the latest successful drill and review the scheduled-job logs and alerts.

   ```bash
   docker/ops/backup.sh create
   docker/ops/backup.sh verify "$BACKUP_ID"
   docker/ops/backup.sh test-restore "$BACKUP_ID"
   ```

The restore check uses a disposable database. Follow the [recovery runbook](recovery.md) for storage, alerts, release rollback, and recovery decisions.

## Acceptance matrix

The backend checks exercise the live routes on disposable PostgreSQL and render with sandboxed Chromium. Representative fixture PDFs for all six forms were also visually inspected. Municipal form approval, physical print checks, and React Native integration remain separate acceptance steps.

| Form | API and data checks | PDF and print checks |
| --- | --- | --- |
| CAFOA | Create and revise; numeric strings, detail and ledger rows, null spacers, derived amount and balance, dated official snapshot | A4 portrait; municipal logo, request, certifications, and subsidiary ledger. Print all four supported signatory slots with representative long names. |
| RAAOCO | Create and revise Capital Outlay; shared budget and actual row shape, null row and amount slots, computed row total | A4 landscape; correct class title, budget before actual, and spacer height in the shared layout. |
| RAAOFE | Create and revise Financial Expenses; shared row and total rules | A4 landscape; correct class title and populated budget, actual, and detail columns. |
| RAAOMOOE | Create and revise Maintenance and Other Operating Expenses; shared row and total rules | A4 landscape; verify the long title wraps cleanly and detail columns remain legible. |
| RAAOPS | Create and revise Personal Services; shared row and total rules | A4 landscape; correct class title and budget/actual sections. RAAO forms have no signatory slots. |
| SAAOB | Create, revise, finalize, and archive; nested offices, categories, and entries; nullable nested lists; exact balances and totals; independent signatory snapshots | A4 portrait; office/category/grand totals and Prepared By / Certified By blocks. Verify a long statement across physical pages. |

| Cross-cutting scenario | Backend acceptance |
| --- | --- |
| Authorization and device revocation | Reject pending or revoked devices, invalid proof, and stale sessions. Verify refresh rotation, replay response, unauthorized role grants, and client-visible `401`, `403`, or scoped `404`. |
| Historical revision and signatory reprint | Reprint an older SAAOB revision after publishing a new version and renaming its signatory. Restore a superseded CAFOA revision from a real dump and verify the original template digest and embedded historical logo. |
| Remote assets and Eta injection | Reject template/source/asset overrides at input or publication. Confirm requests to HTTP and local files are denied with no server hit. Render markup and Eta-like text literally without executing it. |
| Print renderer | Check one-page fixtures, paper size, orientation, margin, logo, and row spacing. Repeat the test with production printer settings, long labels, and page-breaking data for release acceptance. |

## Critical review findings

| Finding | Operational effect |
| --- | --- |
| The first-administrator bootstrap is a plan. There is no checked-in executable for that one-time transaction. | A fresh install needs an approved provisioning procedure and verified recovery for administrator access before rollout. |
| No general signatory or office registry APIs are exposed. The template field schema describes stored and rendered fields, including server-owned values. | The client needs a provisioned source for registry IDs and office codes, and must submit editable fields only. Treat these as integration dependencies for dynamic forms. |
| Finalization enforces structure and revision state. Missing data and unsigned drafts can meet those rules. | Use the office approval checklist until mandatory fields, signatory policy, and completeness rules are formally specified and enforced. |
| The current templates use \`serialNumber\` in HTML metadata only. | Confirm whether the office requires a visible serial number before accepting the print layout. |
| Device proof is a software credential. The auth limits are per API process and use the peer IP. | Verify secure storage, single-flight refresh, and revocation on the actual devices. Behind a shared reverse proxy, check for a shared rate-limit bucket and configure edge throttling for deployment. |
| Archived snapshots pin source, schema, assets, and engine versions. The image and physical printer affect layout. | Keep the corresponding renderer image and retain issued bytes when required. Restrict write access to template publication, databases, and backup bundles because Eta runs as server-side code. |
