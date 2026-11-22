# Device enrollment and session persistence

The internal enrollment service accepts a verified account ID and a device label. It returns the new pending device ID and a random 256-bit credential once. The device row stores its SHA-256 verifier. Approval and revocation require a trusted operator context. Future routes must derive actor IDs from authenticated context and check the applicable RBAC grant before calling either transition. The service verifies credential proof only for an approved device owned by an active user. Device approval leaves role assignment and session creation to their own flows.

Store the credential in the client OS secure credential store for that installation. A copied credential can satisfy the device proof if it is presented with the other required authentication material. This is software binding. Physical binding would require an OS-protected private key and request signing, with attestation if required.

## Initial administrator bootstrap plan

1. Have the office designate the first administrator and a deployment operator through its provisioning process. Provision the named account through the approved password-hashing path. Arrange its password and recovery material through the approved private channels.
2. Once password verification and a secure local enrollment adapter exist, enroll the designated installation through that adapter. Deliver the generated credential directly to that installation's secure storage. The deployment operator verifies the pending device ID and account ID through a separate channel.
3. Run a one-time maintenance operation from the deployment host under a temporary privileged identity. Require explicit account and pending device IDs. In one transaction, serialize bootstrap attempts, confirm the selected active account owns the pending device, and require both the absence of an existing administrator grant and the absence of a prior bootstrap audit event. Apply the designated administrator role, approve that one device through the enrollment service, and record the bootstrap audit event with the operator identity and target IDs. Abort the transaction if any condition fails. Revoke temporary maintenance access after verifying the result. Subsequent approval and recovery use the authorized administrator workflow.

The password path, local adapter, and one-time command are prerequisites for carrying out this plan in the auth and RBAC stages. They should accept secrets through protected input and keep secrets out of command arguments, stdout, and audit data.

## Session and token contract for the auth stage

- Use an `auth_sessions` row as the token family. Its user and device must agree with the enrollment row. Lock in user, device, then session order for login, refresh, and other paths that acquire those locks. Recheck the device while holding its lock through session creation or refresh so device revocation serializes with those writes.
- Check user, device, and session state before accepting a token. Revocation marks the device and its sessions in the same transaction. A revoked or expired session invalidates every token in its family, including an unconsumed row.
- Use high-entropy opaque refresh tokens. Store SHA-256 hashes and bound each token expiry by the session expiry. In one transaction, consume the current token before inserting its same-session successor. Retain consumed hashes through the replay-detection window and revoke the session on reuse. The schema constrains lineage and the number of unconsumed rows. Auth-stage code implements the rotation, expiry checks, and replay response.

## Migration and tests

The migration creates the device status enum, three tables, indexes, and foreign keys. Its only dependency on existing rows is the foreign key to `users`. Review and apply it through Drizzle Kit. To run the device integration tests, point `DEVICE_TEST_DATABASE_URL` at a disposable PostgreSQL database with the migrations applied and run `pnpm test`. The tests roll back their fixture transactions.
