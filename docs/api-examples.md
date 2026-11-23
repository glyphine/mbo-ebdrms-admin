# API examples for client integration

These examples use paths relative to the API origin and synthetic values. Replace brace placeholders with actual IDs, credentials, or revision numbers. Use JSON request bodies with `Content-Type: application/json`. Use `Authorization: Bearer <accessToken>` on protected calls. Read the deployed OpenAPI contract from `GET /openapi.json`.

## Enroll, approve, log in, rotate, and revoke

```http
POST /api/v1/auth/enroll
{"email":"staff@example.test","password":"{password}","label":"Budget Office phone"}
```

`201` returns `deviceId`, `deviceCredential`, and `status: "pending"`. Save the credential immediately in iOS Keychain or Android Keystore-backed storage. Approval requires a separate administrator session with `devices.manage`.

```http
GET /api/v1/admin/devices/pending
Authorization: Bearer {adminAccessToken}

POST /api/v1/admin/devices/{deviceId}/approve
Authorization: Bearer {adminAccessToken}

POST /api/v1/auth/login
{"email":"staff@example.test","password":"{password}","deviceId":"{deviceId}","deviceCredential":"{deviceCredential}"}

POST /api/v1/auth/refresh
{"deviceId":"{deviceId}","deviceCredential":"{deviceCredential}","refreshToken":"{latestRefreshToken}"}
```

Match the pending list's `id` to the enrollment's `deviceId` and confirm the `userId`. Approve returns `204`. Login and refresh return `200` with `accessToken`, `refreshToken`, `tokenType: "Bearer"`, and `expiresIn` in seconds. Validate the active session with `GET /api/v1/auth/me`. Keep access tokens in memory and refresh tokens in secure storage. Share one in-flight refresh across client requests and save its replacement before refreshing again. If the refresh result is lost or rejected, log in again. Replaying a consumed token with valid device proof revokes the session family.

```http
POST /api/v1/admin/devices/{deviceId}/revoke
Authorization: Bearer {adminAccessToken}

GET /api/v1/auth/me
Authorization: Bearer {revokedDeviceAccessToken}
```

Revoke returns `204`. The subsequent access check and a refresh with that device return `401`. Approval and revocation record `device.approved` and `device.revoked` activity events respectively. To end only the caller's current session, use `POST /api/v1/auth/logout`. `DELETE /api/v1/auth/devices/{deviceId}/sessions` ends that caller's sessions on the specified device and preserves its enrollment.

## Choose the exact form version

```http
GET /api/v1/templates
Authorization: Bearer {accessToken}

GET /api/v1/templates/{templateId}/versions/{versionNumber}
Authorization: Bearer {accessToken}
```

Select the listing's `versionId` for the desired `code` and submit it as `templateVersionId`. The version response provides the recursive `fieldSchema` and saved `pdfOptions`. For existing documents, use the version pinned to the revision. Document and revision lists return up to 50 items. Pass the last item's document ID or revision number as `after` on the corresponding list.

## Create and revise CAFOA

```http
POST /api/v1/documents
Authorization: Bearer {accessToken}

{"title":"Supplies certificate","templateVersionId":"{cafoaVersionId}","values":{"payeeName":"Sample Supplier","approvedAmount":"150.00","details":[{"expenseCode":"001","amount":"150.00"},null],"ledgers":[{"date":"2026-11-24","particulars":"Request","obligation":"150.00"},null]},"signatories":[{"slotKey":"official","signatoryId":"{activeSignatoryId}","date":"2026-11-24"}]}

POST /api/v1/documents/{cafoaId}/revisions
Authorization: Bearer {accessToken}

{"expectedRevision":1,"values":{"payeeName":"Sample Supplier","approvedAmount":"175.00","details":[{"expenseCode":"001","amount":"175.00"},null],"ledgers":[{"date":"2026-11-24","particulars":"Updated request","obligation":"175.00"},null]}}
```

## Create and revise RAAO

The same body shape applies to RAAOCO, RAAOFE, RAAOMOOE, and RAAOPS. Use the version ID for the desired class.

```http
POST /api/v1/documents
Authorization: Bearer {accessToken}

{"title":"November registry","templateVersionId":"{raaoVersionId}","values":{"reportingMonth":"November 2026","budgetRows":[{"appropriationAmount":"1000.00","allotmentAmount":"750.00","details":["750.00"]}],"actualRows":[null,{"particulars":"Sample activity","details":[null,"125.00"]}]}}

POST /api/v1/documents/{raaoId}/revisions
Authorization: Bearer {accessToken}

{"expectedRevision":1,"values":{"reportingMonth":"November 2026","budgetRows":[{"appropriationAmount":"1000.00","allotmentAmount":"750.00","details":["750.00"]}],"actualRows":[null,{"particulars":"Sample activity","details":[null,"150.00"]}]}}
```

## Create and revise SAAOB

Use a provisioned office code for attributed report rows. Omitting the code leaves the financial projection unassigned. ISO coverage dates enable date filtering on the financial dashboard.

```http
POST /api/v1/documents
Authorization: Bearer {accessToken}

{"title":"November statement","templateVersionId":"{saaobVersionId}","fiscalYear":2026,"values":{"startDate":"2026-11-01","endDate":"2026-11-30","offices":[{"code":"{registeredOfficeCode}","name":"Sample office","categories":[{"name":"Operations","entries":[{"name":"Supplies","accountCode":"001","appropriations":"1000.00","allotment":"750.00","obligation":"125.00"}]}]},{"name":"Office without entries","categories":null}]},"signatories":[{"slotKey":"preparedBy","signatoryId":"{activeSignatoryId}"}]}

POST /api/v1/documents/{saaobId}/revisions
Authorization: Bearer {accessToken}

{"expectedRevision":1,"values":{"startDate":"2026-11-01","endDate":"2026-11-30","offices":[{"code":"{registeredOfficeCode}","name":"Sample office","categories":[{"name":"Operations","entries":[{"name":"Supplies","accountCode":"001","appropriations":"1000.00","allotment":"750.00","obligation":"150.00"}]}]},{"name":"Office without entries","categories":null}]}}
```

Each create/revise returns `201` with the document identity and `currentRevision`. Revise sends a full replacement of editable `values`. Omit `signatories` on revise to keep the previous snapshots. Supply a full replacement array or `[]` to clear them. Preserve decimal strings and the distinction between a missing value and a null spacer where allowed. Leave out computed amounts, balances and totals, and pass signatory IDs outside `values`. The [document contract](documents.md#server-owned-values) lists server-owned fields.

## Finalize, download, and print

```http
POST /api/v1/documents/{documentId}/finalize
Authorization: Bearer {accessToken}

{"expectedRevision":2,"fundCode":"100"}

GET /api/v1/documents/{documentId}/revisions/3/pdf
Authorization: Bearer {accessToken}
Accept: application/pdf
```

With the needed grant and current draft at revision 2, finalize returns `200` and appends finalized revision 3. Use the confirmed fund code for the document. The server returns its allocated `serialNumber`. Omit `serialNumber` from create and revise requests. The PDF needs both read and export grants and returns a private attachment. Use the revision number the operator selected, including older revisions. Store the download only in protected app storage if needed, then open the system print dialog using the returned PDF. A successful download is audited.

Handle status codes and the standard `error.code` and `error.requestId` fields. Use `400` to correct invalid form input, `401` to recover the session, and `403` or `404` for denied or unavailable resources. For a stale `409`, reload and reconcile. A `429` or busy PDF `503` can include `Retry-After`. Avoid automatically repeating document creation and refresh after a lost response. Create has no idempotency key, and refresh tokens are single-use.

The [reporting contract](financial-reports.md) covers finalized SAAOB sources, exact decimal aggregates, and matching report PDF snapshots. Backup and restore use the [operator commands](operator-runbook.md) on the Compose host.
