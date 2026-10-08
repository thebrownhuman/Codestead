import { expect, test } from "@playwright/test";

declare global {
  interface Window { cspViolations: string[] }
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.cspViolations.push(`${event.effectiveDirective}: ${event.blockedURI}`);
    });
  });
  await page.route("**/api/monitoring/envelope", (route) => route.fulfill({ json: { enabled: false } }));
});

test("key pages render and hydrate with fresh nonces and no CSP console errors", async ({ page }) => {
  const errors: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /content.security.policy|violates|refused to|unsafe-eval/i.test(message.text())) errors.push(message.text());
  });
  const nonces = new Set<string>();
  expect(process.env.CSP_SESSION_COOKIE, "Run npm run test:csp for the disposable authenticated fixture").toBeTruthy();
  const routes = ["/", "/login", "/request-access", "/forgot-password", "/lost-device", "/learn", "/playground", "/courses/python/skills/python.toolchain.repl"];
  for (const route of routes) {
    if (route === "/learn") {
      await page.context().addCookies([{ name: "__Secure-learncoding.session_token", value: process.env.CSP_SESSION_COOKIE!, domain: "localhost", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    }
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe(route);
    expect(response!.headers()["cache-control"]).toContain("no-store");
    const csp = response!.headers()["content-security-policy"];
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(nonces.has(nonce!)).toBe(false);
    nonces.add(nonce!);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp.split(";").find((directive) => directive.trim().startsWith("script-src "))).not.toContain("'unsafe-inline'");
    await expect(page.locator("h1").first()).toBeVisible();
    expect(await page.locator("script:not([src])").evaluateAll((scripts) => scripts.every((script) => Boolean((script as HTMLScriptElement).nonce)))).toBe(true);
    if (route === "/login") {
      await page.getByRole("button", { name: "Show password" }).click();
      await expect(page.locator("input#password")).toHaveAttribute("type", "text");
    }
    if (route === "/playground" || route.includes("/skills/")) {
      if (route.includes("/skills/")) await page.getByRole("tab", { name: "Code", exact: true }).click();
      await expect(page.locator(".monaco-editor").first()).toBeVisible({ timeout: 30_000 });
      // Exercise the JavaScript language worker, rather than merely loading the shell.
      if (route === "/playground") {
        await page.getByRole("combobox", { name: "Runner language" }).click();
        await page.getByRole("option", { name: "JavaScript", exact: true }).click();
        await expect(page.locator(".monaco-editor").first()).toBeVisible();
      }
    }
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
  }
  expect(errors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("Google OAuth can navigate out through the same-origin sign-in endpoint", async ({ page }) => {
  await page.route("**/api/auth/sign-in/social", (route) => route.fulfill({ json: { url: "https://accounts.google.com/o/oauth2/v2/auth?csp-test=1", redirect: true } }));
  await page.route("https://accounts.google.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>OAuth navigation reached Google</h1>" }));
  await page.goto("/login");
  await page.getByRole("button", { name: /Continue with Google/ }).click();
  await expect(page).toHaveURL(/accounts\.google\.com/);
});

test("Sentry loads and sends browser errors through the same-origin GlitchTip relay", async ({ page }) => {
  let envelope = "";
  await page.route("**/api/monitoring/envelope", async (route) => {
    if (route.request().method() === "POST") {
      envelope = route.request().postData() ?? "";
      await route.fulfill({ status: 200, json: {} });
    } else {
      await route.fulfill({ json: { enabled: true, release: "csp-browser-test" } });
    }
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => { setTimeout(() => { throw new Error("csp-relay-verification"); }, 0); });
  await expect.poll(() => envelope, { timeout: 15_000 }).toContain("csp-relay-verification");
  expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
});

