# Authorization and access administration

Every protected request first verifies the access JWT and the current user, device, and session. Authorization resolves the active user's role grants from PostgreSQL on each request. Global grants match the named action across applicable document types. A document-type grant matches only the named action and the exact type. Administrative actions require global grants. Missing grants deny access, and document ownership and `managingOfficeId` provide no implicit access.

## Document guards

Use `requirePermission` after `authenticate` for routes that need a global grant. Use `authorizeDocumentType` for operations scoped to a document type and `authorizeDocument` for an existing record. The record guard resolves the type from the saved template relationship. Document writes must recheck expected status and revision in the mutation transaction.

| Permission | Eligible status |
| --- | --- |
| `documents.create` | Active document type |
| `documents.read` | Draft, finalized, or voided |
| `documents.revise`, `documents.finalize` | Draft |
| `documents.void` | Finalized |
| `documents.export` | Draft or finalized |

Existing records remain subject to their grants when a type is retired. Lifecycle and PDF routes can add their own revision-specific requirements.

## Administrator routes

All paths below start with `/api/v1/admin` and require a bearer access token. Lists return up to 50 rows ordered by ID. Use the last ID as `?after=<id>` to continue.

| Required global permission | Method and path | Operation |
| --- | --- | --- |
| `devices.manage` | `GET /devices/pending` | List pending enrollments. |
| `devices.manage` | `POST /devices/:deviceId/approve` or `/revoke` | Approve a pending enrollment or revoke the enrollment and its sessions. |
| `users.manage` | `GET /users` | List account IDs and basic account details. |
| `users.manage` | `PATCH /users/:userId/status` | Set `isActive`. Disabling an account revokes all its sessions in the same transaction. |
| `roles.manage` | `GET /roles` | List existing roles. |
| `roles.manage` | `PUT` or `DELETE /users/:userId/roles/:roleId` | Assign or remove an existing role. |
| `roles.manage` | `PUT` or `DELETE /roles/:roleId/permissions/:permission` | Add or remove a global document permission by name. |
| `roles.manage` | `PUT` or `DELETE /roles/:roleId/document-types/:documentTypeId/permissions/:permission` | Add or remove a permission for one document type. |

Role managers can delegate only grants they hold at the requested scope. Assigning or removing a role requires the manager to hold every grant on it. A role carrying a global administrator grant, and the enabled status of its holders, are managed through trusted provisioning. API grant edits cover the document permissions listed above. Administrator provisioning uses the existing role and permission tables and the [bootstrap plan](device-enrollment.md#initial-administrator-bootstrap-plan).

Role and permission changes write `activity_logs` entries with the actor, target, and scope in the same transaction. Repeating an already-applied operation produces no duplicate audit entry. Removed grants take effect on the next request even if the caller still holds a valid JWT. Status changes close outstanding sessions, so re-enabling an account requires a new login even for accounts previously disabled outside the API.

Run `pnpm test` with `DEVICE_TEST_DATABASE_URL` set to a migrated disposable PostgreSQL database to exercise the guards and routes with live grants.
