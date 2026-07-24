import type { EmailTemplate } from "./outbox";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function validUrl(value: string | undefined) {
  if (!value) return undefined;
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error("Email action URL is invalid.");
  if (url.username || url.password) throw new Error("Email action URL is invalid.");
  return url.toString();
}

function appealUpdate(decision: string | undefined): string {
  if (decision === "needs_learner_input") {
    return "A reviewer needs more information for your appeal. Open Codestead for the recorded request.";
  }
  if (decision === "overturned") {
    return "Your appeal was granted. The original evidence remains preserved while corrective review is completed.";
  }
  if (decision === "upheld") {
    return "Your appeal was reviewed and the original result was upheld. Open Codestead for the recorded reason.";
  }
  return "Your appeal has a new human-review update. The original evidence remains preserved.";
}

const subjects: Record<EmailTemplate, string> = {
  "verify-email": "Verify your Codestead email",
  "reset-password": "Reset your Codestead password",
  invitation: "Your Codestead invitation",
  "access-request-admin": "A Codestead access request needs review",
  "lost-device-proof": "Confirm your Codestead lost-device request",
  "access-rejected": "Your Codestead access request",
  "learning-request-updated": "Your Codestead curriculum request was reviewed",
  "new-device": "A Codestead device was approved",
  "session-revocation-requested": "A device revocation needs review",
  "session-revocation-updated": "Your device revocation request was reviewed",
  "session-revoked": "A Codestead session was revoked",
  "account-deleted": "Your Codestead account was deleted",
  "credential-changed": "Your AI provider credential changed",
  "credential-revealed": "An administrator revealed your provider key",
  "fallback-grant-changed": "Your administrator-funded AI fallback changed",
  "learning-plan-changed": "Your Codestead learning plan changed",
  "storage-quota-changed": "Your Codestead storage quota changed",
  "inactivity-reminder": "Ready for one good learning step?",
  "inactivity-reminder-followup": "Your learning path is ready when you are",
  "inactivity-admin-notice": "A learner inactivity episode started",
  "daily-study-reminder": "Ready for one small coding step?",
  "revision-reminder": "A short skill refresh is ready",
  "goal-reminder": "Plan one useful learning step this week",
  "challenge-reminder": "Your coding challenge is coming up",
  "exam-result": "Your Codestead exam result is ready",
  "mastery-awarded": "You earned a mastery badge",
  "appeal-updated": "Your appeal has an update",
  "assessment-corrected": "Your Codestead assessment was regraded",
  "weekly-summary": "Your weekly learning summary",
  "backup-status": "Codestead backup status",
};

export function renderEmail(
  template: EmailTemplate,
  variables: Record<string, string>,
) {
  const name = variables.name?.trim() || "buddy";
  const actionUrl = validUrl(variables.url);
  let lead: string;
  let action = "Open Codestead";
  switch (template) {
    case "verify-email": lead = "Confirm this email address to finish activating your private learning account."; action = "Verify email"; break;
    case "reset-password": lead = "A password reset was requested. If this was not you, do not use the link and tell the administrator."; action = "Reset password"; break;
    case "invitation": lead = "The administrator approved your private pilot access. This invitation expires and can be used once."; action = "Activate account"; break;
    case "access-request-admin": lead = "A new private-pilot access request is waiting for administrator review."; action = "Review request"; break;
    case "lost-device-proof": lead = "Confirm that you requested help with the only active browser profile. This short-lived link is single-use and only opens an administrator review; it does not sign you in or reset a password or authenticator."; action = "Confirm lost-device request"; break;
    case "access-rejected": lead = "The administrator reviewed your private-pilot request and cannot offer a learning seat at this time. No account was created."; action = "Learn more"; break;
    case "learning-request-updated": lead = `The administrator reviewed your curriculum request${variables.subject ? ` for ${variables.subject}` : ""}. Open Codestead to see the decision and recorded reason.`; action = "View request"; break;
    case "new-device": lead = "A new browser profile was approved for your account. Contact the administrator immediately if you do not recognize it."; action = "Review security"; break;
    case "session-revocation-requested": lead = `A learner requested revocation of ${variables.device ?? "an approved browser profile"}. Confirm the learner's identity before deciding.`; action = "Review request"; break;
    case "session-revocation-updated": lead = `Your browser-profile revocation request was ${variables.decision ?? "reviewed"}. ${variables.reason ?? "Open Codestead for the recorded decision."}`; action = "Review security"; break;
    case "session-revoked": lead = `${variables.device ?? "A browser profile"} was revoked by the administrator. Contact the administrator immediately if you did not expect this action.`; action = "Review security"; break;
    case "account-deleted": lead = `Your Codestead account and primary application data were deleted by the administrator. Existing encrypted backups are not claimed erased immediately; restore points age out under the backup policy, no earlier than ${variables.backupRetentionUntil ?? "the disclosed retention date"}.`; action = "Contact the administrator"; break;
    case "credential-changed": lead = `Your ${variables.provider ?? "AI provider"} credential was changed. The key itself is never included in email.`; action = "Review providers"; break;
    case "credential-revealed": lead = `An administrator revealed the full ${variables.provider ?? "AI provider"} key after fresh MFA and a recorded reason. This action was audited; the key itself is never included in email.`; action = "Review providers"; break;
    case "fallback-grant-changed": lead = `Administrator-funded ${variables.provider ?? "AI"} fallback access was ${variables.action ?? "changed"}. ${variables.summary ?? "Open Codestead to review the time and token limits."}`; action = "Review providers"; break;
    case "learning-plan-changed": lead = `Your administrator ${variables.action ?? "updated"} the ${variables.course ?? "learning"} plan as revision ${variables.revision ?? "a new revision"}. The recorded reason is available in Codestead. Your mastery evidence and prerequisite gates were not rewritten.`; action = "Review roadmap"; break;
    case "storage-quota-changed": lead = `Your administrator changed your storage quota to ${variables.quota ?? "the configured limit"}. The action was protected by fresh MFA and recorded in the security audit.`; action = "Review storage"; break;
    case "inactivity-reminder": lead = "You have not completed a meaningful learning activity in 24 hours. One short review is enough to restart your rhythm."; action = "Continue learning"; break;
    case "inactivity-reminder-followup": lead = "There has not been a meaningful learning activity in 72 hours. This is the final reminder for this inactivity episode; reminders resume only after you learn again and a future episode begins."; action = "Continue learning"; break;
    case "inactivity-admin-notice": lead = "A learner has entered the disclosed inactivity-reminder episode. Open the mentor dashboard for authorized details. This email intentionally omits learner identity and all learning evidence."; action = "Open mentor dashboard"; break;
    case "daily-study-reminder": lead = "You have not recorded a meaningful learning step today. A tiny practice task is enough; opening the app alone does not count."; action = "Choose one step"; break;
    case "revision-reminder": lead = "At least one concept is due for a short retrieval practice. The review queue chooses previous learning that is most useful to recall now."; action = "Start a five-question review"; break;
    case "goal-reminder": lead = "Your active roadmap is ready for a weekly check-in. Choose a realistic next step; this reminder never invents progress or pressure."; action = "Review roadmap"; break;
    case "challenge-reminder": lead = "A coding challenge you joined is scheduled to start soon. Open Codestead for the server-authoritative start time and rules."; action = "View challenge"; break;
    case "exam-result": lead = "Your exam result and evidence are ready. Scores remain private."; action = "View result"; break;
    case "mastery-awarded": lead = `You demonstrated independent mastery${variables.topic ? ` in ${variables.topic}` : ""}.`; action = "View badge"; break;
    case "appeal-updated": lead = appealUpdate(variables.decision); action = "View appeal"; break;
    case "assessment-corrected": lead = `A reviewed faulty assessment version was corrected and your work was deterministically regraded. The original result remains preserved. Your effective outcome is now ${variables.outcome ?? "available in Codestead"}.`; action = "View corrected result"; break;
    case "weekly-summary": lead = variables.summary ?? "Your weekly learning summary is ready."; action = "Open dashboard"; break;
    case "backup-status": lead = variables.summary ?? "A backup operation needs administrator attention. No archive is attached to this email."; action = "Open operations"; break;
  }
  const safeName = escapeHtml(name);
  const safeLead = escapeHtml(lead);
  const button = actionUrl
    ? `<p style="margin:24px 0"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#17462d;color:#fff;text-decoration:none;font-weight:700">${escapeHtml(action)}</a></p>`
    : "";
  return {
    subject: subjects[template],
    text: `Hi ${name},\n\n${lead}${actionUrl ? `\n\n${action}: ${actionUrl}` : ""}\n\n— Codestead\nBuild skills that stay.`,
    html: `<!doctype html><html><body style="margin:0;background:#f3f5ef;font-family:Arial,sans-serif;color:#172019"><div style="max-width:600px;margin:0 auto;padding:32px 20px"><div style="padding:26px;border:1px solid #d8ded5;border-radius:18px;background:#fffef9"><p style="margin:0 0 4px;color:#225e3d;font-weight:800">Codestead</p><p style="margin:0 0 18px;color:#738077;font-size:12px">Build skills that stay.</p><h1 style="font-size:24px;margin:0 0 12px">Hi ${safeName},</h1><p style="line-height:1.6;color:#526057">${safeLead}</p>${button}<p style="margin-top:24px;font-size:12px;color:#738077">Never send API keys, passwords, recovery codes, code submissions, or backup archives by email.</p></div></div></body></html>`,
  };
}
