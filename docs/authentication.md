# Device-gated authentication

Account provisioning uses `hashPassword` in `src/auth/password.ts` to produce the versioned `scrypt-v1` verifier stored in `users.password_hash`. Supply the password through protected input. This release verifies that format. Accounts with other formats need an explicit migration or password reset. Sign-in uses the stored email spelling and the exact password, including spaces.

Set `AUTH_JWT_KEYS` to a JSON object mapping key IDs to independently generated 32-byte base64url keys and set `AUTH_JWT_ACTIVE_KID` to the signing key ID. Keep keys in deployment secrets, scoped to the environment. `AUTH_JWT_ISSUER` and `AUTH_JWT_AUDIENCE` default to `ebdrms-api` and `ebdrms-mobile`. To rotate, distribute the new key to every verifier, change the active key, then remove the old key after the last JWT signed with it can no longer be valid.

## Routes

Routes are relative to `/api/v1/auth`. Use HTTPS when deployed. Enrollment, login, refresh, and session-management requests have per-route IP limits. The limits are process-local, and the API uses the peer IP unless trusted proxy support is configured at deployment.

| Method and path | Request | Result |
| --- | --- | --- |
| `POST /enroll` | JSON `email`, `password`, `label` | `201` with `deviceId`, `deviceCredential`, and `status: pending`. The device credential is returned once. |
| `POST /login` | JSON `email`, `password`, `deviceId`, `deviceCredential` | `200` with `accessToken`, `refreshToken`, `tokenType`, and `expiresIn` in seconds. The device must be approved. |
| `POST /refresh` | JSON `deviceId`, `deviceCredential`, `refreshToken` | `200` with a new access and refresh token. |
| `GET /me` | Bearer access token | `200` with `userId`, `deviceId`, and `sessionId`. |
| `POST /logout` | Bearer access token | `204`. Revokes the current session. |
| `DELETE /devices/:deviceId/sessions` | Bearer access token | `204`. Revokes all sessions for the caller's enrollment on that device. The device stays approved. |

Access JWTs last 10 minutes. Refresh tokens are single-use and share the session's 30-day absolute expiry. Every protected request checks the live user, device, and session. A refresh replay with valid device proof revokes the entire session family, including access JWTs already issued for it. Attempts without valid device proof leave the family intact.

## React Native client

Save the device ID and credential per enrolled account in iOS Keychain or Android Keystore-backed secure storage. Store the refresh token there as well, and keep the access JWT in memory. Omit credentials from analytics, URLs, logging, and crash reports. Keep one refresh request in flight per session and persist the replacement refresh token before sending another refresh. If the refresh response is lost or refresh returns `401`, sign in again. Retrying an already-consumed token with valid device proof revokes that session. After logout, clear local session tokens and keep the enrollment credential for later login.

## Account administration

The existing internal approval and revocation services remain available to the later RBAC stage. When account management is added, close existing sessions in the same transaction as password reset or account disablement so re-enabling an account cannot restore a prior session. Apply role changes through live authorization checks. See the [bootstrap plan](device-enrollment.md#initial-administrator-bootstrap-plan) for the first administrator.
