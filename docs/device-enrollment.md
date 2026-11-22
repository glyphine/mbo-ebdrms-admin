# Device enrollment and session persistence

The internal enrollment service accepts a verified account ID and a device label. It returns the new pending device ID and a random 256-bit credential once. The device row stores its SHA-256 verifier. The [administrator routes](authorization.md#administrator-routes) derive the actor ID from authenticated context and require `devices.manage` before approving or revoking enrollment. The service verifies credential proof only for an approved device owned by an active user. Device approval leaves role assignment and session creation to their own flows.

Store the credential in the client OS secure credential store for that installation. A copied credential can satisfy the device proof if it is presented with the other required authentication material. This is software binding. Physical binding would require an OS-protected private key and request signing, with attestation if required.

## Initial administrator bootstrap plan

1. Have the office designate the first administrator and a deployment operator through its provisioning process. Provision the named account through the approved password-hashing path. Arrange its password and recovery material through the approved private channels.
2. From the designated installation, request enrollment through the password-verified endpoint over HTTPS and save the credential to that installation's secure storage. The deployment operator verifies the pending device ID and account ID through a separate channel.
3. Run a one-time maintenance operation from the deployment host under a temporary privileged identity. Require explicit account and pending device IDs. In one transaction, serialize bootstrap attempts, confirm the selected active account owns the pending device, and require both the absence of an existing administrator grant and the absence of a prior bootstrap audit event. Apply the designated administrator role, approve that one device through the enrollment service, and record the bootstrap audit event with the operator identity and target IDs. Abort the transaction if any condition fails. Revoke temporary maintenance access after verifying the result. Subsequent approval and recovery use the authorized administrator workflow.

The one-time maintenance command remains a prerequisite for carrying out the bootstrap. Account provisioning should accept the password through protected input and keep it out of command arguments, stdout, and audit data. See the [authentication contract](authentication.md) for the supported password hash format.

## Session and token contract for the auth stage

- Use an `auth_sessions` row as the token family. Its user and device must agree with the enrollment row. Lock in user, device, then session order for login, refresh, and other paths that acquire those locks. Recheck the device while holding its lock through session creation or refresh so device revocation serializes with those writes.
- Check user, device, and session state before accepting a token. Revocation marks the device and its sessions in the same transaction. A revoked or expired session invalidates every token in its family, including an unconsumed row.
- Refresh uses high-entropy opaque tokens with SHA-256 verifiers and the same absolute expiry as the session. It consumes the current token before inserting its same-session successor in one transaction. Consumed hashes remain available for replay detection, and proof-backed reuse revokes the session. The schema constrains lineage and the number of unconsumed rows.

## Migration and tests

The migration creates the device status enum, three tables, indexes, and foreign keys. Its only dependency on existing rows is the foreign key to `users`. Review and apply it through Drizzle Kit. To run the device integration tests, point `DEVICE_TEST_DATABASE_URL` at a disposable PostgreSQL database with the migrations applied and run `pnpm test`. The tests roll back their fixture transactions.
