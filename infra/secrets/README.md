# Runtime secrets

Production secrets live in `/etc/learncoding/secrets`, never in this repository or a Docker image. Create the directory as root with mode `0700`; every file should be root-owned and mode `0400`. Compose mounts the files read-only and the entrypoint converts only the required value into the child process environment.

Required filenames:

- `postgres_password`: a random database password.
- `database_url`: the complete `postgresql://...` URL using the same password; percent-encode reserved URL characters.
- `better_auth_secret`: at least 32 random bytes.
- `lost_device_proof_key`: at least 32 independent random bytes shared only by the application and mail worker to derive short-lived mailbox proofs without storing them plaintext.
- `deletion_tombstone_key`: at least 32 independent random bytes used only for keyed, irreversible account-deletion identity hashes.
- `credential_master_key`: exactly 32 bytes encoded as base64 (`openssl rand -base64 32`).
- `runner_shared_secret`: at least 32 random bytes, copied through a secure one-time channel to the isolated runner VM.
- `google_client_secret`: the OAuth client secret, or an empty file until Google login is enabled.
- `gmail_client_id`: the Gmail OAuth client ID, or an empty file while console delivery is used.
- `gmail_client_secret`: the Gmail OAuth client secret, or an empty file while console delivery is used.
- `gmail_refresh_token`: the Gmail OAuth refresh token, or an empty file while console delivery is used.
- `cloudflare_tunnel_credentials.json`: issued by Cloudflare for this tunnel.

Generate independent values; do not reuse the database, auth, credential-encryption, or runner secrets. A typical random text secret can be generated with `openssl rand -base64 48`. Commands must write directly to root-owned files without echoing values to a terminal or shell history. Never include secret files, OAuth tokens, private `age` identities, or email exports in backups.

Rotate one secret at a time using the incident runbook. The `credential_master_key` is different: rotating it requires re-wrapping every stored learner credential before the old key is destroyed.
