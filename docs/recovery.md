# Backups, restore tests, and releases

## Backup scope and storage

Each completed backup is a private directory with a UTC identifier. It contains:

| Item | Coverage |
| --- | --- |
| `database.dump` | PostgreSQL custom-format dump of the entire application database. Includes revision values, exact template version references, published Eta source and partials, field and PDF options, print CSS, embedded municipal logos, financial records, and audit history. |
| `api-image.tar.gz` | Archive of the **running** API image by image ID. Includes that release's reviewed `templates/` tree, other printable assets, runtime system fonts, renderer dependencies, and any compiled styles shipped in the image. The current renderer compiles Tailwind in memory from trusted inputs, so there is no separate compiled CSS store. Retain release images separately by registry digest for older renderer or font versions. |
| `external.tar.gz` | Present when `EBDRMS_BACKUP_EXTERNAL_DIR` is set. Includes the complete configured tree of issued PDFs and any runtime-mounted trusted templates, fonts, logos, printable assets, or compiled styles. |
| `configuration.tar.gz` | Present when `EBDRMS_BACKUP_CONFIG_DIR` is set. Archives the protected configuration tree separately from document assets. The scheduled example includes `/etc/ebdrms`. |
| Image references and `SHA256SUMS` | Identify the API and PostgreSQL images and detect corruption. A checksum is an integrity check, so protect the entire backup and its access credentials. |

The current API streams PDFs and has no issued-PDF file store. An operator who keeps issued PDFs, uploads, or other required assets outside PostgreSQL and the image must keep them under the configured external directory or provision an independently verified backup for their store. The archives cover regular files and directories. Quiesce changes to the external tree for a coordinated snapshot because `pg_dump` and the external archive are taken separately. Keep Compose settings and secret files in the protected configuration tree, or use an independently backed-up secret store. Keep instructions or approved definitions for database roles and grants with the recovery configuration. Include the active release pin in the protected configuration backup.

Create a dedicated backup directory owned by the operations account with mode `0700`. Use an encrypted filesystem or encrypted backup destination on separate storage outside the checkout and PostgreSQL volume. Keep an independently protected off-host copy of completed bundles and test from that copy periodically. Do not expose backup files or their logs to application users. The default local retention is 14 days. The job prunes expired completed bundles for its Compose project after successfully publishing a new dump and image archive. A failed job leaves any prior bundles available. Storage sizing must account for an image archive per bundle and a disposable PostgreSQL copy. The scheduler, Docker context, and deploy operators must share the same project and backup location.

## Schedule and alerting

On a Linux Docker host with systemd, install the units under [docker/ops/systemd](../docker/ops/systemd/). The defaults use user `ebdrms-ops`, checkout `/opt/ebdrms`, and protected `/etc/ebdrms/operations.env`. Adapt those values via systemd drop-ins for the host. The operations account needs access to the Compose environment files, the backup storage, and the Docker daemon. Docker socket access is equivalent to host administration on a conventional rootful daemon.

Copy [operations.env.example](../docker/ops/operations.env.example) to `/etc/ebdrms/operations.env` and set the actual Compose project and file paths. `EBDRMS_COMPOSE_ENV_FILE` is the Compose interpolation file for settings such as the API port. Set it to `/dev/null` if no overrides are needed. The scripts require the API and maintenance URLs to target `db:5432` and the database declared by the Compose PostgreSQL service. URL query overrides are rejected. The backup uses the existing PostgreSQL service credentials because it must read the entire app database. Configuration and credentials stay outside image layers.

```bash
sudo install -m 0644 docker/ops/systemd/* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start ebdrms-backup@create.service
sudo systemctl start ebdrms-backup@test-latest.service
sudo systemctl enable --now ebdrms-backup.timer ebdrms-test-restore.timer
journalctl -u 'ebdrms-backup@*' -u 'ebdrms-backup-alert@*'
```

Backups run daily at 02:00 UTC and restore checks run Sundays at 05:00 UTC. Persistent timers catch missed runs after downtime. Failures produce a nonzero service status and an error-priority journal event via `OnFailure`. Set `EBDRMS_BACKUP_NOTIFY` to an absolute executable that forwards its single status-message argument to the existing alerting service. Test delivery and monitor the last successful backup and restore timestamps so a missing timer or unreachable host is detected. The notifier receives project and operation names, with no credentials or record data.

## Verification and recovery drill

For a manual invocation, export the operations settings in the shell of the same account.

```bash
docker/ops/backup.sh create
docker/ops/backup.sh verify "$BACKUP_ID"
docker/ops/backup.sh test-restore "$BACKUP_ID"
docker/ops/backup.sh test-latest
test/backup-ops.sh mbo-ebdrms-api:local
```

`verify` checks the complete bundle manifest against the archived files. The backup also checks that `pg_restore` can read the archive catalog. `test-restore` restores with `--exit-on-error --single-transaction` into a fresh isolated PostgreSQL container that has a disposable filesystem, no host network or published port, and no connection to the live database. It checks the migration journal, checks the external tar if present, and uses the archived API image to check both health routes and render a recovered revision. Selection prefers a revision whose published version has been superseded. The check uses the exact snapshot digest and verifies that a sampled CAFOA PDF contains an embedded logo. A database with no revisions pinned to published snapshots reports the render check as skipped. The local integration test uses a superseded CAFOA version with a distinct historical logo. If a host crash interrupts the drill, find any remaining disposable PostgreSQL containers by their `ebdrms.restore.project` label and remove them after checking the project name.

For a real incident, stop writes, choose a verified recovery point, and plan downtime and reconciliation of writes after that point. Restore to a **new** isolated cluster or database and restore external files into a new protected directory after inspecting the archive. Recreate roles and grants from protected configuration, validate the restored records and PDF exports, and obtain explicit approval before switching application traffic. The disposable test deliberately omits ownership and grants. Restoring a custom dump does not recover cluster-global roles, point-in-time WAL, or writes after the dump snapshot. A re-render may differ if the runtime fonts or renderer changed. Preserve issued PDF bytes externally when the originally issued file is required. Review backup retention with records owners and retain the corresponding image archive and registry release for any long-term recovery point.

## Deploy and roll back the application image

Run both commands on the Compose host with the operations environment exported. Use reviewed immutable image references. Without `--apply`, the commands print the plan and exit. Applying requires a terminal and confirmation of the exact operation and project.

```bash
docker/ops/release.sh deploy "$NEW_IMAGE_DIGEST"
docker/ops/release.sh deploy "$NEW_IMAGE_DIGEST" --apply
docker/ops/release.sh rollback "$PREVIOUS_IMAGE_DIGEST"
docker/ops/release.sh rollback "$PREVIOUS_IMAGE_DIGEST" --apply
```

Deployment validates Compose, checks availability of the pinned release, creates and test-restores a fresh backup, and rehearses the forward migrations on that disposable copy. It checks historical rendering with both releases after the rehearsal when a suitable revision exists. It then applies forward migrations to the Compose database, switches the API image, and checks liveness and readiness. Record the previous image digest, review migration SQL and grants, and confirm the old and new APIs both support the resulting schema before applying. Use backward-compatible expand-and-contract releases. The sample restore and HTTP health checks do not establish compatibility across all business operations.

Rollback takes and test-restores a new backup, checks the candidate image against the restored current schema, and switches only the API image. The database stays at its current schema and data version. If startup or verification fails, the operation exits nonzero. Inspect the logs and current container before deciding which previous compatible image to deploy. A migration failure or incompatible schema requires an operator-led recovery decision. There is no automatic database downgrade, restore onto live records, or automatic image rollback.

After a successful switch the script records the verified pin in `$EBDRMS_BACKUP_DIR/$COMPOSE_PROJECT_NAME/api-image.env`. For subsequent manual Compose changes, include this file as the last `--env-file` and unset a stale shell `EBDRMS_API_IMAGE` override. Preserve the pin in the protected configuration backup. Compose restart policies continue to use the existing container configuration.
