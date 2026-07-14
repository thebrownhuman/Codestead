# Runtime secrets

Production secrets live in `/etc/learncoding/secrets`, never in this repository or a Docker image. The host uses the fixed `codestead-secrets` group (GID 2000) so only containers that mount secrets receive supplemental read access. Keep regular host users out of this group. Runtime validation requires the directory to be exactly `root:codestead-secrets` mode `0750` and every secret file to be exactly `root:codestead-secrets` mode `0440`; symlinks are rejected.

```bash
sudo groupadd --system --gid 2000 codestead-secrets
sudo install -d -o root -g codestead-secrets -m 0750 /etc/learncoding/secrets
```

Compose mounts each file read-only, grants GID 2000 only to services that consume at least one secret, and the entrypoint converts only the required value into the child process environment. Keep `SECRETS_GID=2000` in the installed Compose environment.

Secret inventory:

- `postgres_password`: a random database password.
- `database_url`: the complete `postgresql://...` URL using the same password; percent-encode reserved URL characters.
- `better_auth_secret`: at least 32 random bytes.
- `bootstrap_admin_password`: operations-only temporary random text containing at least 16 non-whitespace characters. Create it only for the initial administrator bootstrap, then remove it after the administrator changes the password and the non-secret `bootstrap_admin.created` evidence is retained.
- `lost_device_proof_key`: at least 32 independent random bytes shared only by the application and mail worker to derive short-lived mailbox proofs without storing them plaintext.
- `deletion_tombstone_key`: at least 32 independent random bytes used only for keyed, irreversible account-deletion identity hashes.
- `credential_master_key`: exactly 32 bytes encoded as base64 (`openssl rand -base64 32`).
- `runner_shared_secret`: at least 32 random bytes, copied through a secure one-time channel to the isolated runner VM.
- `google_client_secret`: the OAuth client secret, or an empty file until Google login is enabled.
- `gmail_client_id`: the Gmail OAuth client ID, or an empty file while console delivery is used.
- `gmail_client_secret`: the Gmail OAuth client secret, or an empty file while console delivery is used.
- `gmail_refresh_token`: the Gmail OAuth refresh token, or an empty file while console delivery is used.
- `cloudflare_tunnel_credentials.json`: issued by Cloudflare for this tunnel.

All files except `bootstrap_admin_password` must exist during ordinary pilot validation. The Google and Gmail placeholder files always exist with the exact ownership and mode above. Keep `google_client_secret` empty while `GOOGLE_CLIENT_ID` is empty. Keep all three Gmail files empty while `MAIL_ADAPTER=console`; populate all three only when `MAIL_ADAPTER=gmail`.

After creating or replacing the inventory, restore exact metadata without reading or printing any value:

```bash
sudo chown root:codestead-secrets /etc/learncoding/secrets/*
sudo chmod 0440 /etc/learncoding/secrets/*
```

Generate independent values; do not reuse the database, auth, credential-encryption, or runner secrets. A typical random text secret can be generated with `openssl rand -base64 48`. Commands must write directly to root-owned files without echoing values to a terminal or shell history. Never include secret files, OAuth tokens, private `age` identities, or email exports in backups.

Rotate one secret at a time using the incident runbook. The `credential_master_key` is different: rotating it requires re-wrapping every stored learner credential before the old key is destroyed. Ordinary validation uses `VALIDATION_MODE=pilot`; pass `VALIDATION_MODE=operations` only while `bootstrap_admin_password` exists and the initial administrator bootstrap is being run.
