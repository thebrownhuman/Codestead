import { expect, test } from "@playwright/test";

test.describe("access and public security", () => {
  test("access request requires adult confirmation and sends the bounded payload", async ({ page }) => {
    let submitted: Record<string, unknown> | undefined;
    await page.route("**/api/access-requests", async (route) => {
      submitted = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      await route.fulfill({
        contentType: "application/json",
        status: 202,
        body: JSON.stringify({ message: "Request received for administrator review." }),
      });
    });

    await page.goto("/request-access");
    await expect(page.getByRole("heading", { name: "Request a learning seat" })).toBeVisible();
    await page.getByLabel("Your name").fill("Test Learner");
    await page.getByLabel("Email address").fill("learner@example.test");
    await page.getByLabel(/what would you like to learn/i).fill("Python and DSA");

    await page.getByRole("button", { name: "Send request" }).click();
    await expect(page.getByLabel(/18 or older/i)).toBeFocused();

    await page.getByLabel(/18 or older/i).check();
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(page.getByText("Request received for administrator review.")).toBeVisible();
    expect(submitted).toEqual({
      name: "Test Learner",
      email: "learner@example.test",
      reason: "Python and DSA",
      adultConfirmed: true,
    });
  });

  test("password remains concealed until the learner explicitly reveals it", async ({ page }) => {
    await page.goto("/login");
    const password = page.locator("input#password");
    await expect(password).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(password).toHaveAttribute("type", "text");
    await expect(page.getByRole("button", { name: "Hide password" })).toBeVisible();
  });

  test("password recovery does not disclose whether an account exists", async ({ page }) => {
    await page.route("**/api/auth/request-password-reset", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({
          status: true,
          message: "If this email exists in our system, check your email for the reset link",
        }),
      });
    });
    await page.goto("/forgot-password");
    await page.getByLabel("Email address").fill("unknown@example.test");
    await page.getByRole("button", { name: "Email a reset link" }).click();
    await expect(page.getByText(/if that approved account exists/i)).toBeVisible();
  });

  test("lost-device request is neutral and submits only the approved email", async ({ page }) => {
    let submitted: Record<string, unknown> | undefined;
    await page.route("**/api/lost-device/request", async (route) => {
      submitted = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      await route.fulfill({
        contentType: "application/json",
        status: 202,
        body: JSON.stringify({
          ok: true,
          message:
            "If an eligible account has an active browser profile, a short-lived confirmation link has been emailed.",
        }),
      });
    });
    await page.goto("/lost-device");
    await page.getByLabel("Approved account email").fill("unknown@example.test");
    await page.getByRole("button", { name: "Email a confirmation link" }).click();
    await expect(page.getByText(/if an eligible account has an active browser profile/i)).toBeVisible();
    expect(submitted).toEqual({ email: "unknown@example.test" });
  });

  test("lost-device mailbox proof stays out of HTTP navigation and creates only a review request", async ({ page }) => {
    const proof = "browser-only-proof-value-12345678901234567890";
    let submitted: Record<string, unknown> | undefined;
    await page.route("**/api/lost-device/verify", async (route) => {
      submitted = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      await route.fulfill({
        contentType: "application/json",
        status: 201,
        body: JSON.stringify({
          ok: true,
          message:
            "Your mailbox was confirmed. The administrator must still verify your identity and approve the revocation.",
        }),
      });
    });
    await page.goto(`/lost-device#proof=${proof}`);
    await expect(page).toHaveURL(/\/lost-device$/);
    await page
      .getByLabel("Why can you no longer use the approved browser profile?")
      .fill("The only approved laptop was stolen while travelling.");
    await page.getByRole("button", { name: "Confirm and request review" }).click();
    await expect(page.getByText(/administrator must still verify your identity/i)).toBeVisible();
    expect(submitted).toEqual({
      proof,
      reason: "The only approved laptop was stolen while travelling.",
    });
    await expect(page.locator("body")).not.toContainText(proof);
  });

  test("password reset rejects a mismatched confirmation before the API call", async ({ page }) => {
    let resetCalls = 0;
    await page.route("**/api/auth/reset-password", async (route) => {
      resetCalls += 1;
      await route.fulfill({ contentType: "application/json", status: 200, body: JSON.stringify({ status: true }) });
    });
    await page.goto("/reset-password?token=synthetic-single-use-token");
    await page.getByLabel("New password", { exact: true }).fill("a-strong-password-1");
    await page.getByLabel("Confirm new password").fill("a-different-password-2");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.locator("p[role='alert']")).toContainText("do not match");
    expect(resetCalls).toBe(0);
  });

  test("a valid reset token changes the password and requires a fresh sign-in", async ({ page }) => {
    let submitted: Record<string, unknown> | undefined;
    await page.route("**/api/auth/reset-password", async (route) => {
      submitted = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      await route.fulfill({ contentType: "application/json", status: 200, body: JSON.stringify({ status: true }) });
    });
    await page.goto("/reset-password?token=synthetic-single-use-token");
    await page.getByLabel("New password", { exact: true }).fill("a-strong-password-1");
    await page.getByLabel("Confirm new password").fill("a-strong-password-1");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Password changed. Existing sessions have been revoked.")).toBeVisible();
    expect(submitted).toEqual({ newPassword: "a-strong-password-1", token: "synthetic-single-use-token" });
  });

  test("public responses include the configured defensive headers", async ({ request }) => {
    const response = await request.get("/");
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).toContain("object-src 'none'");
  });
});
