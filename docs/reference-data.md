# Magpet reference data and document numbering

After applying the reviewed migrations, run the seed with the maintenance database account and the repository's `DATABASE_URL` configuration.

```bash
pnpm seed:reference
```

For Compose, use `docker compose run --rm migrate node dist/reference-data/seed-cli.js`. The seed is explicit and does not run on application startup. It reports inserted, linked, unchanged, and conflicting records by code. Each run is transactional. Resolve conflicts with the Municipal Budget Office and keep any intentional corrections in the registry. The seed leaves conflicting names, nonempty parent links, and document-type activation settings as stored. It fills a missing parent for an existing subdivision whose name still matches the supplied registry.

The Magpet office registry is project-supplied and subject to Municipal Budget Office confirmation. Office codes remain exact strings and subdivisions link to the Mayor's office by UUID. The reusable classification codes are `PS`, `MOOE`, `CO`, and `FE`. `SPA` is a special grouping. Existing reports still filter on the office UUIDs and saved SAAOB category labels in each source revision. The classification registry does not reinterpret historical line items or totals.

The baseline funds are `100` General Fund, `200` Special Education Fund, and `300` Trust Fund. The 2016 manual lists all three in its form instructions, and the 2023 manual gives examples for `100` and `200`. The RAAO sample's `101` is unresolved. Confirm it with the Municipal Budget Office before adding a new registry entry or revising a draft. The seed creates no `101` entry or alias and preserves existing `101` data. [DBM 2016 manual](https://www.dbm.gov.ph/wp-content/uploads/Issuances/2016/Local%20Budget%20Circular/LBC-112-BOM-inside%20pages-correct%20paging-FINAL.pdf#page=140), [DBM 2023 manual](https://www.dbm.gov.ph/wp-content/uploads/Issuances/2023/Local-Budget-Circular/Budget%20Operations%20Manual%20for%20LGUs%2C%202023%20Edition.pdf#page=196).

## Document numbering

Finalize with `{ "expectedRevision": 2, "fundCode": "100" }`. The code must be a registered three-character string. For a RAAO draft whose saved fund is a numeric three-digit code, the request must match it. Human-readable fund labels in the form remain editable text and require operator confirmation of the selected code.

Finalization allocates `SSSS-MM-YY-FFF` from one annual sequence shared by all six forms and funds. The month and year come from the issuance date in Asia/Manila. The reporting fiscal year stays independent. The first serial may be `0001-01-27-100`. This is an internal E-BDRMS policy adapted from the project-supplied CAFOA Appendix 28 structure. The shared series and separators are E-BDRMS conventions. [COA Circular 2020-004 and LGU GAM volumes](https://www.coa.gov.ph/wpfd_file/coa-circular-no-2020-004-january-31-2020/).

The counter, identity, finalized revision, financial projections, and audit change commit together. The series stops at `9999`. Further issuance in that year returns `409` and the draft stays open. On first allocation for a year, the service starts above the highest recognizable serial saved in historical revisions for that two-digit year. This reserves existing numbers without editing prior documents. Existing duplicate or nonstandard historical values remain in their original revision. A legacy draft may receive a new serial only on successful finalization. Read older issued serials from the original revision. Current published templates place `serialNumber` in HTML metadata. A visible printed serial requires a separately reviewed template publication.

## Cutover

Use a verified pre-deploy backup. Review the additive migration and allow a maintenance window for constraints and indexes on existing tables. Pause document writes during switching so older application instances cannot issue records outside the new series. Apply migrations, run the maintenance seed, review its conflicts, and grant the runtime role access before resuming document writes.

```sql
GRANT SELECT ON funds, expenditure_classifications, document_serial_counters TO ebdrms_api;
GRANT INSERT (year, last_value), UPDATE (last_value) ON document_serial_counters TO ebdrms_api;
GRANT UPDATE (serial_number, serial_fund_code) ON documents TO ebdrms_api;
```

Send the updated finalization body from the client, then verify one finalization per form family. An image rollback to a pre-policy release can read the retained data, but document issuance must remain paused until the allocator is back in service. See [backup verification and release operations](recovery.md).
