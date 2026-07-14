import { eq, sql } from "drizzle-orm";

import { auth } from "../src/lib/auth";
import { db, pool } from "../src/lib/db/client";
import { user } from "../src/lib/db/schema";
import { runAuthorizedBootstrap } from "../src/lib/security/activation-context";

async function main() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || "Codestead Administrator";
  if (!email || !password) {
    throw new Error("Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD in the environment.");
  }
  if (password.length < 16) throw new Error("Bootstrap administrator password must be at least 16 characters.");

  const [existing] = await db
    .select({ id: user.id, email: user.email, role: user.role })
    .from(user)
    .where(sql`lower(${user.email}) = ${email}`)
    .limit(1);
  if (existing) {
    if (existing.role !== "admin") {
      throw new Error(
        "BOOTSTRAP_ADMIN_EMAIL already belongs to a non-admin account; refusing automatic privilege escalation.",
      );
    }
    console.info(JSON.stringify({ event: "bootstrap_admin.exists", email }));
    return;
  }

  const [anotherAdmin] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.role, "admin"))
    .limit(1);
  if (anotherAdmin) {
    throw new Error(
      "An administrator already exists; this single-administrator deployment refuses a second bootstrap account.",
    );
  }

  const result = await runAuthorizedBootstrap(email, () =>
    auth.api.signUpEmail({
      body: { email, password, name },
    }),
  );
  await db
    .update(user)
    .set({
      role: "admin",
      status: "pending",
      mustChangePassword: true,
      adultConfirmedAt: new Date(),
    })
    .where(eq(user.id, result.user.id));
  console.info(
    JSON.stringify({
      event: "bootstrap_admin.created",
      email,
      next: "Process the email outbox, verify the address, sign in, change the bootstrap password, and enroll TOTP.",
    }),
  );
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ event: "bootstrap_admin.failed", code: error instanceof Error ? error.name : "UNKNOWN" }));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
