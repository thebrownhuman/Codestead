# Codestead NUC Runtime Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make the trusted Codestead Compose stack safe to deploy on the Ubuntu NUC, recover automatically after power loss, and run its private pilot without upload infrastructure.

**Architecture:** Codestead remains a no-host-port Compose project behind its dedicated Cloudflare Tunnel. Pilot mode excludes ClamAV, one-shot operations use a dedicated image, file secrets are readable only through a supplemental numeric group, and systemd recreates reviewed images from durable bind mounts after boot. The KVM runner and encrypted backup implementation are separate plans.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.9, Vitest, Node.js 22.23.1, PostgreSQL 17, Drizzle ORM, Docker Engine 29, Docker Compose 5, Bash, systemd, and cloudflared.

## Global Constraints

- Pilot mode is UPLOADS_ENABLED=false with no uploads Compose profile.
- The trusted stack publishes no ports and never contains a runner service.
- Production images are independently named and pinned by sha256 digest.
- Long-running services use restart: unless-stopped; one-shot jobs use restart: "no".
- Every service has com.centurylinklabs.watchtower.enable=false.
- Secret directory metadata is root:GID-2000 mode 0750; secret files are root:GID-2000 mode 0440.
- Only secret-consuming containers receive supplemental GID 2000.
- Durable application data lives under /srv/learncoding.
- PostgreSQL runs with fsync, synchronous_commit, and full_page_writes enabled.
- Boot never builds an image or changes existing NUC services, ports, networks, or tunnels.
- Readiness requires a successful minimal PostgreSQL query.
- No learner invitations occur before all final verification commands and the separate runner/backup plans pass.

---

## File Map

**Create:**

- src/lib/storage/upload-feature.ts
- scripts/migrate-production.mjs
- scripts/__tests__/migrate-production.test.ts
- src/app/health/live/route.ts
- src/app/health/ready/route.ts
- src/app/health/__tests__/routes.test.ts
- infra/ops/smoke-production.sh
- infra/tests/smoke-production.test.sh
- infra/tests/systemd-recovery.test.sh

**Modify:**

- src/app/api/files/route.ts
- src/app/api/files/__tests__/route.test.ts
- src/components/product/file-library.tsx
- src/components/product/__tests__/file-library.test.tsx
- Dockerfile
- infra/docker/entrypoint.sh
- compose.yaml
- infra/env/compose.env.example
- infra/ops/validate-runtime.sh
- infra/tests/runtime-config.test.sh
- infra/tests/validate-compose.mjs
- infra/tests/validate-static.mjs
- infra/secrets/README.md
- infra/systemd/learncoding-compose.service
- infra/systemd/learncoding-retention.service
- docs/deployment.md
- docs/runbooks/logs-and-monitoring.md
- docs/runbooks/updates-and-rollback.md
- .github/workflows/ci.yml

---

### Task 1: Fail-Closed Pilot Uploads

**Files:**

- Create: src/lib/storage/upload-feature.ts
- Modify: src/app/api/files/route.ts
- Test: src/app/api/files/__tests__/route.test.ts
- Modify: src/components/product/file-library.tsx
- Test: src/components/product/__tests__/file-library.test.tsx
- Modify: infra/env/compose.env.example

**Interfaces:**

- Produces uploadsEnabled(environment?: NodeJS.ProcessEnv): boolean.
- GET /api/files adds uploadsEnabled.
- Disabled POST returns 503 before request.formData is called.
- Task 3 passes UPLOADS_ENABLED to the app; Task 4 validates it.

- [ ] **Step 1: Write the failing API tests**

Add a per-test UPLOADS_ENABLED=true setup, restore the original environment after each test, assert GET returns uploadsEnabled: true, and add:

    it("rejects disabled uploads before reading the request body", async () => {
      process.env.UPLOADS_ENABLED = "false";
      const formData = vi.fn(async () => {
        throw new Error("body was parsed");
      });
      const response = await POST({ formData } as unknown as NextRequest);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        code: "UPLOADS_DISABLED",
        error: "Project file uploads are disabled during the private pilot.",
      });
      expect(formData).not.toHaveBeenCalled();
      expect(mocks.reserve).not.toHaveBeenCalled();
      expect(response.headers.get("cache-control")).toContain("no-store");
    });

- [ ] **Step 2: Prove the API test is red**

Run:

    npm exec vitest run -- src/app/api/files/__tests__/route.test.ts

Expected: FAIL because the body is parsed and GET has no capability field.

- [ ] **Step 3: Add the policy and route gate**

Create src/lib/storage/upload-feature.ts:

    export function uploadsEnabled(environment: NodeJS.ProcessEnv = process.env) {
      return environment.UPLOADS_ENABLED === "true";
    }

Return uploadsEnabled: uploadsEnabled() from GET. Immediately after successful POST authentication add:

    if (!uploadsEnabled()) {
      return NextResponse.json(
        {
          code: "UPLOADS_DISABLED",
          error: "Project file uploads are disabled during the private pilot.",
        },
        { status: 503, headers: { "Cache-Control": "private, no-store" } },
      );
    }

- [ ] **Step 4: Prove the API test is green**

Run:

    npm exec vitest run -- src/app/api/files/__tests__/route.test.ts

Expected: PASS.

- [ ] **Step 5: Write the failing UI test**

Add uploadsEnabled: true to existing fixtures and add:

    it("keeps existing files usable while pilot uploads are disabled", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => json({
        ...populated,
        uploadsEnabled: false,
      })));
      render(<FileLibrary />);
      expect(await screen.findByText("solution.py")).toBeInTheDocument();
      expect(screen.queryByLabelText("Choose a project file")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();
      expect(screen.getByText(/Uploads are disabled during the private pilot/i)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Download/i })).toBeInTheDocument();
    });

- [ ] **Step 6: Prove the UI test is red**

Run:

    npm exec vitest run -- src/components/product/__tests__/file-library.test.tsx

Expected: FAIL because upload controls always render.

- [ ] **Step 7: Render capability-driven UI**

Add readonly uploadsEnabled: boolean to FileLibraryResponse. Render the existing input, Upload button, and quarantine copy only when library?.uploadsEnabled is true. Otherwise render:

    <p className={styles.fileSafety}>
      <ShieldCheck size={14} />
      Uploads are disabled during the private pilot. Existing safe files remain available.
    </p>

Add to infra/env/compose.env.example:

    UPLOADS_ENABLED=false
    COMPOSE_PROFILES=

- [ ] **Step 8: Run and commit**

Run:

    npm exec vitest run -- src/app/api/files/__tests__/route.test.ts src/components/product/__tests__/file-library.test.tsx
    git add src/lib/storage/upload-feature.ts src/app/api/files/route.ts src/app/api/files/__tests__/route.test.ts src/components/product/file-library.tsx src/components/product/__tests__/file-library.test.tsx infra/env/compose.env.example
    git commit -m "feat(runtime): disable pilot uploads fail closed"

Expected: tests PASS and commit succeeds.

---

### Task 2: Advisory-Locked Migration and Operations Image

**Files:**

- Create: scripts/migrate-production.mjs
- Test: scripts/__tests__/migrate-production.test.ts
- Modify: Dockerfile
- Modify: infra/docker/entrypoint.sh
- Modify: infra/tests/validate-static.mjs

**Interfaces:**

- Produces acquireMigrationLock(client, options) and runProductionMigration(options).
- Produces Docker targets tooling and operations.
- Produces BOOTSTRAP_ADMIN_PASSWORD_FILE loading.
- Task 3 consumes the image targets.

- [ ] **Step 1: Write failing lock tests**

Create scripts/__tests__/migrate-production.test.ts with:

    import { describe, expect, it, vi } from "vitest";
    import { acquireMigrationLock, runProductionMigration } from "../migrate-production.mjs";

    describe("production migration", () => {
      it("polls until the advisory lock is acquired", async () => {
        const query = vi.fn()
          .mockResolvedValueOnce({ rows: [{ acquired: false }] })
          .mockResolvedValueOnce({ rows: [{ acquired: true }] });
        const sleep = vi.fn(async () => undefined);
        let time = 0;
        await acquireMigrationLock(
          { query },
          { timeoutMs: 1000, pollMs: 25, now: () => (time += 10), sleep },
        );
        expect(query).toHaveBeenCalledTimes(2);
        expect(String(query.mock.calls[0]?.[0])).toContain("pg_try_advisory_lock");
        expect(sleep).toHaveBeenCalledWith(25);
      });

      it("unlocks and closes resources after migration failure", async () => {
        const client = {
          query: vi.fn()
            .mockResolvedValueOnce({ rows: [{ acquired: true }] })
            .mockResolvedValueOnce({ rows: [{ released: true }] }),
          release: vi.fn(),
        };
        const pool = { connect: vi.fn(async () => client), end: vi.fn(async () => undefined) };
        const migrate = vi.fn(async () => { throw new Error("migration failed"); });
        await expect(runProductionMigration({
          connectionString: "postgresql://test",
          pool,
          migrate,
          drizzle: vi.fn(() => ({})),
        })).rejects.toThrow("migration failed");
        expect(String(client.query.mock.calls.at(-1)?.[0])).toContain("pg_advisory_unlock");
        expect(client.release).toHaveBeenCalledOnce();
        expect(pool.end).toHaveBeenCalledOnce();
      });
    });

- [ ] **Step 2: Prove tests are red**

Run:

    npm exec vitest run -- scripts/__tests__/migrate-production.test.ts

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement the migration module**

Create scripts/migrate-production.mjs. Export acquireMigrationLock and runProductionMigration. Use lock name codestead:production-migration:v1, query:

    select pg_try_advisory_lock(hashtextextended($1, 0)) acquired

Poll every 500 ms for at most 120 seconds. Hold the session connection while Drizzle migrate runs against /app/drizzle. In finally, query:

    select pg_advisory_unlock(hashtextextended($1, 0)) released

Then release the client and end the pool. The executable main requires DATABASE_URL, logs only database.migrated or database.migration_failed plus an error class, and never logs the URL.

- [ ] **Step 4: Update Docker targets**

In tooling copy scripts/migrate-production.mjs and use:

    CMD ["node", "/app/scripts/migrate-production.mjs"]

Add:

    FROM worker AS operations
    COPY --chown=node:node content ./content
    COPY --chown=node:node scripts/bootstrap-admin.ts ./scripts/bootstrap-admin.ts
    COPY --chown=node:node scripts/seed-platform.ts ./scripts/seed-platform.ts
    CMD ["node", "--import", "tsx", "/app/scripts/seed-platform.ts"]

Add BOOTSTRAP_ADMIN_PASSWORD to the entrypoint file_env loop. Extend static validation to require the migration script, both operations scripts, content, and the password file variable.

- [ ] **Step 5: Run and commit**

Run:

    npm exec vitest run -- scripts/__tests__/migrate-production.test.ts
    node infra/tests/validate-static.mjs
    docker build --pull=false --target tooling --tag codestead-tooling:plan-check .
    docker build --pull=false --target operations --tag codestead-operations:plan-check .
    git add scripts/migrate-production.mjs scripts/__tests__/migrate-production.test.ts Dockerfile infra/docker/entrypoint.sh infra/tests/validate-static.mjs
    git commit -m "feat(runtime): lock migrations and ship operations image"

Expected: tests and builds PASS; commit succeeds.

---

### Task 3: Profile-Aware Compose and One-Shot Operations

**Files:**

- Modify: compose.yaml
- Modify: infra/env/compose.env.example
- Modify: infra/tests/validate-compose.mjs
- Modify: infra/tests/validate-static.mjs

**Interfaces:**

- Produces pilot, operations, uploads, and combined Compose models.
- Produces platform-seed and admin-bootstrap services.
- Produces seven independent application image inputs.
- Task 4 consumes the service and secret inventory.

- [ ] **Step 1: Write failing profile inventory assertions**

Refactor validate-compose.mjs to render zero or more profiles and assert these exact sets:

    const pilotServices = [
      "app", "cloudflared", "exam-finalization-worker", "mail-worker",
      "migrate", "postgres", "practice-runner-recovery-worker",
      "project-review-correction-worker", "regrade-worker", "reward-worker",
    ];
    const operationServices = ["admin-bootstrap", "lifecycle", "platform-seed"];
    const uploadServices = ["clamav", "scan-worker"];

Render default, operations, uploads, and both profiles. Assert each inventory, existing network/capability/mount rules, no runner, no port, and this label for every service:

    expect(
      service.labels?.["com.centurylinklabs.watchtower.enable"] === "false",
      name + " must opt out of Watchtower",
    );

- [ ] **Step 2: Prove semantic validation is red**

Run:

    node infra/tests/validate-compose.mjs

Expected: FAIL for missing profiles, operations services, or labels. The current single-model failure also shows reward-worker inventory drift.

- [ ] **Step 3: Add profiles, labels, and image inputs**

Add a common anchor:

    x-codestead-managed: &codestead-managed
      labels:
        com.centurylinklabs.watchtower.enable: "false"

Merge it into all services. Add profiles: ["uploads"] to clamav and scan-worker. Pass UPLOADS_ENABLED: $UPLOADS_ENABLED to app. Use a harmless inactive image value for ClamAV so pilot interpolation does not require its digest; Task 4 requires the digest when uploads are active.

Replace derived tags with:

    APP_RUNTIME_IMAGE
    APP_TOOLING_IMAGE
    APP_WORKER_IMAGE
    APP_REGRADE_WORKER_IMAGE
    APP_PROJECT_REVIEW_WORKER_IMAGE
    APP_SCANNER_WORKER_IMAGE
    APP_OPERATIONS_IMAGE

Map runtime to app; tooling to migrate; worker to mail/reward; regrade to the three runner coordinators; project-review to its correction worker; scanner to scan-worker; operations to lifecycle/seed/bootstrap. Add all seven GHCR digest-form examples to compose.env.example.

- [ ] **Step 4: Add operations services**

Add platform-seed and admin-bootstrap under profiles: ["operations"], target operations, restart: "no", dependency migrate: service_completed_successfully, data network only, hardened settings, no host port, and the managed label.

platform-seed command:

    ["node", "--import", "tsx", "/app/scripts/seed-platform.ts"]

admin-bootstrap command:

    ["node", "--import", "tsx", "/app/scripts/bootstrap-admin.ts"]

Bootstrap environment uses DATABASE_URL_FILE, BETTER_AUTH_SECRET_FILE, BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD_FILE, APP_URL, and APP_NAME. Declare bootstrap_admin_password as a file-backed Compose secret.

- [ ] **Step 5: Render, test, and commit**

Run:

    docker compose --env-file infra/env/compose.env.example -f compose.yaml config --quiet
    docker compose --env-file infra/env/compose.env.example -f compose.yaml --profile operations config --quiet
    docker compose --env-file infra/env/compose.env.example -f compose.yaml --profile uploads config --quiet
    docker compose --env-file infra/env/compose.env.example -f compose.yaml --profile operations --profile uploads config --quiet
    node infra/tests/validate-compose.mjs
    node infra/tests/validate-static.mjs
    git add compose.yaml infra/env/compose.env.example infra/tests/validate-compose.mjs infra/tests/validate-static.mjs
    git commit -m "feat(runtime): separate pilot and operations compose profiles"

Expected: all renders and validators PASS; commit succeeds.

---

### Task 4: Least-Privilege File Secrets and Runtime Preflight

**Files:**

- Modify: compose.yaml
- Modify: infra/ops/validate-runtime.sh
- Test: infra/tests/runtime-config.test.sh
- Modify: infra/secrets/README.md
- Modify: docs/deployment.md

**Interfaces:**

- Produces SECRETS_GID=2000 and VALIDATION_MODE=pilot|operations.
- Produces exact metadata and profile checks used by systemd ExecStartPre.
- Consumes Task 3 profiles, images, and bootstrap secret.

- [ ] **Step 1: Write failing metadata/profile tests**

Update runtime-config.test.sh to include lost_device_proof_key, SECRETS_GID set to the fixture group, UPLOADS_ENABLED=false, COMPOSE_PROFILES empty, directory mode 0750, and file mode 0440.

Add negative cases for:

- directory mode 0700;
- secret mode 0400 and 0444;
- symlinked secret;
- missing lost_device_proof_key;
- missing deletion_tombstone_key;
- UPLOADS_ENABLED=true without uploads profile;
- uploads profile with no immutable ClamAV digest;
- operations validation with no bootstrap password;
- non-digest application image reference.

Each case must assert one exact fatal message and must never print file contents.

- [ ] **Step 2: Prove the runtime test is red**

Run on Linux or WSL:

    bash infra/tests/runtime-config.test.sh

Expected: FAIL because current validation allows loose metadata, omits lost-device key, and always requires ClamAV.

- [ ] **Step 3: Implement exact preflight**

In validate-runtime.sh reject symlinks and compare stat UID, GID, and mode. Require directory root:$SECRETS_GID mode 750 and files root:$SECRETS_GID mode 440. Required pilot inventory:

    postgres_password
    database_url
    better_auth_secret
    lost_device_proof_key
    deletion_tombstone_key
    credential_master_key
    runner_shared_secret
    cloudflare_tunnel_credentials.json

Require bootstrap_admin_password only in operations mode. Require Gmail values only for MAIL_ADAPTER=gmail. Accept only literal true or false for UPLOADS_ENABLED. Require true to match COMPOSE_PROFILES containing uploads and a digest-pinned CLAMAV_IMAGE; require false not to activate uploads.

Require digest form for PostgreSQL, cloudflared, and all seven application image variables.

- [ ] **Step 4: Give only consumers the supplemental group**

Add SECRETS_GID=2000 to compose.env.example. Add:

    group_add:
      - $SECRETS_GID

only to postgres, migrate, app, mail-worker, reward-worker, regrade-worker, exam-finalization-worker, practice-runner-recovery-worker, project-review-correction-worker, scan-worker, lifecycle, platform-seed, admin-bootstrap, and cloudflared. Semantic validation must require the group on services with secrets and reject it on services without secrets.

- [ ] **Step 5: Correct host documentation**

Document:

    sudo groupadd --system --gid 2000 codestead-secrets
    sudo install -d -o root -g codestead-secrets -m 0750 /etc/learncoding/secrets
    sudo chown root:codestead-secrets /etc/learncoding/secrets/*
    sudo chmod 0440 /etc/learncoding/secrets/*

Document bootstrap_admin_password as a temporary random value of at least 16 characters, removed after password change and bootstrap evidence.

- [ ] **Step 6: Run and commit**

Run:

    bash infra/tests/runtime-config.test.sh
    node infra/tests/validate-compose.mjs
    node infra/tests/validate-static.mjs
    git add compose.yaml infra/env/compose.env.example infra/ops/validate-runtime.sh infra/tests/runtime-config.test.sh infra/tests/validate-compose.mjs infra/secrets/README.md docs/deployment.md
    git commit -m "fix(runtime): enforce readable least-privilege secrets"

Expected: all tests PASS; commit succeeds.

---

### Task 5: Liveness, Readiness, and Internal Smoke

**Files:**

- Create: src/app/health/live/route.ts
- Create: src/app/health/ready/route.ts
- Test: src/app/health/__tests__/routes.test.ts
- Create: infra/ops/smoke-production.sh
- Test: infra/tests/smoke-production.test.sh
- Modify: compose.yaml
- Modify: infra/tests/validate-static.mjs
- Modify: docs/runbooks/logs-and-monitoring.md

**Interfaces:**

- GET /health/live reports process liveness without database access.
- GET /health/ready reports readiness only after SELECT 1.
- smoke-production.sh --startup-wait 600 is consumed by Task 6.

- [ ] **Step 1: Write failing health tests**

Mock pool.query and assert: live returns 200 {status:"ok"} without a query; ready returns 200 {status:"ready"} after query; database failure returns 503 {status:"unavailable"} without the error message; both responses use Cache-Control: no-store.

- [ ] **Step 2: Prove health tests are red**

Run:

    npm exec vitest run -- src/app/health/__tests__/routes.test.ts

Expected: FAIL because routes are missing.

- [ ] **Step 3: Implement health routes**

live/route.ts:

    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    export function GET() {
      return Response.json({ status: "ok" }, { headers });
    }

ready/route.ts imports pool and executes:

    await pool.query({ text: "select 1", query_timeout: 2000 });

Return ready on success and generic unavailable with status 503 on failure, using the same headers.

- [ ] **Step 4: Point Compose health at readiness**

Set app healthcheck to fetch http://127.0.0.1:3000/health/ready and require status 200. Start cloudflared with metrics on 0.0.0.0:20241 and healthcheck it with:

    ["CMD", "cloudflared", "tunnel", "--metrics", "127.0.0.1:20241", "ready"]

- [ ] **Step 5: Write the failing smoke contract test**

Create a fake docker executable that records calls and returns the ten pilot services, app readiness success, PostgreSQL on/on/on durability output, and healthy cloudflared. Assert smoke succeeds, checks /health/ready and all three SHOW statements, rejects a missing reward-worker, and rejects clamav or scan-worker in pilot output.

- [ ] **Step 6: Prove smoke test is red**

Run:

    bash infra/tests/smoke-production.test.sh

Expected: FAIL because smoke-production.sh is missing.

- [ ] **Step 7: Implement bounded smoke**

smoke-production.sh must use explicit env/file arguments, wait no more than the supplied seconds, require all ten pilot services running, execute readiness inside app, execute SHOW fsync, SHOW synchronous_commit, SHOW full_page_writes inside PostgreSQL, require on/on/on, require UPLOADS_ENABLED=false inside app, reject upload services, and print only production smoke passed on success.

- [ ] **Step 8: Run and commit**

Run:

    npm exec vitest run -- src/app/health/__tests__/routes.test.ts
    bash infra/tests/smoke-production.test.sh
    node infra/tests/validate-static.mjs
    node infra/tests/validate-compose.mjs
    git add src/app/health infra/ops/smoke-production.sh infra/tests/smoke-production.test.sh compose.yaml infra/tests/validate-static.mjs docs/runbooks/logs-and-monitoring.md
    git commit -m "feat(runtime): add readiness and production smoke gates"

Expected: all tests PASS; commit succeeds.

---

### Task 6: Retention and Power-Loss Recovery

**Files:**

- Modify: compose.yaml
- Modify: infra/systemd/learncoding-compose.service
- Modify: infra/systemd/learncoding-retention.service
- Create: infra/tests/systemd-recovery.test.sh
- Modify: infra/tests/validate-static.mjs
- Modify: docs/deployment.md
- Modify: docs/runbooks/updates-and-rollback.md

**Interfaces:**

- Produces boot-safe learncoding-compose.service.
- Produces canonical retention confirmation 2026-07-14.v4.
- Consumes Task 4 preflight and Task 5 smoke.

- [ ] **Step 1: Write the failing recovery contract test**

Create systemd-recovery.test.sh. Assert the Compose unit contains:

    RequiresMountsFor=/opt/learncoding /etc/learncoding /srv/learncoding
    Restart=on-failure
    RestartSec=30s
    ExecStartPre=/usr/bin/bash /opt/learncoding/infra/ops/validate-runtime.sh
    ExecStartPost=/usr/bin/bash /opt/learncoding/infra/ops/smoke-production.sh --startup-wait 600
    --no-build

Assert it does not contain the token --build in ExecStart or ExecReload. Assert retention uses explicit env/file, operations profile, run --rm --no-deps lifecycle. Assert Compose and package.json both contain 2026-07-14.v4. Assert every timer contains Persistent=true. Assert Compose contains fsync=on, synchronous_commit=on, and full_page_writes=on.

- [ ] **Step 2: Prove the recovery test is red**

Run:

    bash infra/tests/systemd-recovery.test.sh

Expected: FAIL because boot currently builds, lacks retry/mount/smoke, retention lacks explicit files, and Compose uses 2026-07-12.v3.

- [ ] **Step 3: Pin database durability and retention**

Add PostgreSQL command arguments:

    postgres
    -c
    fsync=on
    -c
    synchronous_commit=on
    -c
    full_page_writes=on

Change lifecycle confirmation to 2026-07-14.v4.

- [ ] **Step 4: Make systemd startup deterministic**

Set RequiresMountsFor to the three durable/config roots. Keep Docker required and network-online wanted. Use:

    ExecStart=/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --remove-orphans
    ExecStartPost=/usr/bin/bash /opt/learncoding/infra/ops/smoke-production.sh --startup-wait 600
    ExecReload=/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --remove-orphans
    Restart=on-failure
    RestartSec=30s

Retain Type=oneshot, RemainAfterExit=yes, WantedBy=multi-user.target, and the non-volume-removing down command. Do not require the removable backup disk mount.

- [ ] **Step 5: Correct retention invocation**

Use Requires=learncoding-compose.service and:

    ExecStart=/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml --profile operations run --rm --no-deps lifecycle

- [ ] **Step 6: Document boot proof**

Document unit installation, daemon-reload, enable --now for the Compose unit and all three persistent timers, firmware Restore on AC Power Loss: Power On, separate runner VM autostart evidence, and the supervised hard-cut rehearsal. The acceptance criterion is preservation of every acknowledged record with no duplicate XP, mail, or evidence; browser text still marked Unsynced is outside that guarantee.

- [ ] **Step 7: Run and commit**

Run:

    bash infra/tests/systemd-recovery.test.sh
    bash infra/tests/runtime-config.test.sh
    bash infra/tests/smoke-production.test.sh
    node infra/tests/validate-static.mjs
    node infra/tests/validate-compose.mjs
    git add compose.yaml infra/systemd/learncoding-compose.service infra/systemd/learncoding-retention.service infra/tests/systemd-recovery.test.sh infra/tests/validate-static.mjs docs/deployment.md docs/runbooks/updates-and-rollback.md
    git commit -m "fix(runtime): recover trusted stack after power loss"

Expected: all tests PASS; commit succeeds.

---

### Task 7: CI and Final Runtime Verification

**Files:**

- Modify: .github/workflows/ci.yml
- Modify: docs/deployment.md
- Modify: docs/runbooks/logs-and-monitoring.md
- Modify: docs/runbooks/updates-and-rollback.md

**Interfaces:**

- Consumes every prior task.
- Produces clean-checkout runtime evidence and NUC handoff boundaries.

- [ ] **Step 1: Add CI gates**

Add smoke-production.test.sh, systemd-recovery.test.sh, all four Compose renders, and validate-compose.mjs to the application job. Build targets runtime, tooling, worker, operations, regrade-worker, scanner-worker, and project-review-correction-worker with fixed CI tags.

- [ ] **Step 2: Run focused runtime verification**

Run:

    npm exec vitest run -- src/app/api/files/__tests__/route.test.ts src/components/product/__tests__/file-library.test.tsx src/app/health/__tests__/routes.test.ts scripts/__tests__/migrate-production.test.ts
    node infra/tests/validate-static.mjs
    node infra/tests/validate-compose.mjs
    bash infra/tests/runtime-config.test.sh
    bash infra/tests/smoke-production.test.sh
    bash infra/tests/systemd-recovery.test.sh

Expected: every command exits 0.

- [ ] **Step 3: Run full application gates**

Run:

    npm run lint
    npm run typecheck
    npm run security:secrets
    npm run security:encoding
    npm run security:api-surface
    npm run architecture:check
    npm run test:auth-boundary
    npm run test:coverage
    npm run content:validate
    npm run build

Expected: every command exits 0 without skipped runtime tests or reduced thresholds.

- [ ] **Step 4: Build every trusted image target**

Run:

    docker build --pull=false --target runtime --tag codestead-runtime:verification .
    docker build --pull=false --target tooling --tag codestead-tooling:verification .
    docker build --pull=false --target worker --tag codestead-worker:verification .
    docker build --pull=false --target regrade-worker --tag codestead-regrade-worker:verification .
    docker build --pull=false --target project-review-correction-worker --tag codestead-project-review-worker:verification .
    docker build --pull=false --target scanner-worker --tag codestead-scanner-worker:verification .
    docker build --pull=false --target operations --tag codestead-operations:verification .

Expected: all seven builds succeed.

- [ ] **Step 5: Validate final diff and commit**

Run:

    git diff --check
    npm run security:secrets
    git status --short
    git add .github/workflows/ci.yml docs/deployment.md docs/runbooks/logs-and-monitoring.md docs/runbooks/updates-and-rollback.md
    git commit -m "ci(runtime): gate production compose recovery"

Expected: diff and secret scan pass; commit succeeds.

- [ ] **Step 6: Record the handoff**

Report every command executed and its result, exact selected image digests, and these external deployment gates: GHCR publication, Cloudflare credentials/DNS, Gmail OAuth, KVM runner, systemd enablement, encrypted restore drill, reboot rehearsal, and supervised AC-loss rehearsal. Any unexecuted gate must be named and the deployment must not be described as complete.

---

## Self-Review

- Spec coverage maps pilot uploads, profile separation, operations, migration locking, exact secret access, image immutability, Watchtower exclusion, readiness, retention, durability, boot recovery, and CI to tasks.
- KVM construction, backup implementation, credential issuance, registry publication, and physical rehearsals stay in their dedicated plans.
- Names are consistent: UPLOADS_ENABLED, COMPOSE_PROFILES, SECRETS_GID, VALIDATION_MODE, uploadsEnabled, acquireMigrationLock, runProductionMigration, and the seven APP_*_IMAGE inputs.
- Every production-code step has concrete behavior or code, every test step has a command and expected result, and every task ends in an independently reviewable commit.
