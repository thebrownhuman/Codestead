import type { EmailTemplate } from "./outbox";
import { renderEmail } from "./templates";

export interface OutgoingEmail {
  to: string;
  template: EmailTemplate;
  variables: Record<string, string>;
}

function headerValue(value: string, name: string) {
  if (!value || /[\r\n]/.test(value)) throw new Error(`Invalid ${name} header.`);
  return value;
}

async function gmailAccessToken() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Gmail OAuth is not configured.");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Gmail token exchange failed (${response.status}).`);
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("Gmail token exchange returned no access token.");
  return body.access_token;
}

function mimeMessage(input: OutgoingEmail) {
  const rendered = renderEmail(input.template, input.variables);
  const boundary = `learncoding-${crypto.randomUUID()}`;
  const from = headerValue(process.env.MAIL_FROM ?? "Codestead <noreply@example.com>", "From");
  const to = headerValue(input.to, "To");
  const subject = headerValue(rendered.subject, "Subject");
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    rendered.text,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    rendered.html,
    `--${boundary}--`,
  ].join("\r\n");
}

export async function sendEmail(input: OutgoingEmail) {
  if (input.template === "backup-status" && /archive|\.sql|\.tar|\.zip/i.test(input.variables.url ?? "")) {
    throw new Error("Backup archives may not be emailed.");
  }
  const adapter = process.env.MAIL_ADAPTER ?? "console";
  if (adapter === "console") {
    // Deliberately exclude variables: activation/reset URLs contain bearer tokens.
    console.info(JSON.stringify({ event: "email.console_delivery", template: input.template, recipientDomain: input.to.split("@")[1] ?? "invalid" }));
    return { providerId: `console-${crypto.randomUUID()}` };
  }
  if (adapter !== "gmail") throw new Error("MAIL_ADAPTER must be either console or gmail.");
  const raw = Buffer.from(mimeMessage(input), "utf8").toString("base64url");
  // Reject invalid headers before contacting even the OAuth endpoint.
  const accessToken = await gmailAccessToken();
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ raw }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Gmail delivery failed (${response.status}).`);
  const body = (await response.json()) as { id?: string };
  const providerId = body.id?.trim();
  if (!providerId) throw new Error("Gmail delivery returned no message ID.");
  return { providerId };
}
