const DEFAULT_MAIL_FROM_NAME = "Codestead";
const DEFAULT_MAIL_FROM_ADDRESS = "noreply@example.com";

// RFC 5322 atext-safe characters for an unquoted display-name word.
const UNQUOTED_DISPLAY_NAME = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/;

function quoteDisplayName(name: string): string {
  if (UNQUOTED_DISPLAY_NAME.test(name)) return name;
  const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  return `"${escaped}"`;
}

function addressFromLegacyMailFrom(value: string): string {
  const match = value.match(/<([^>]+)>\s*$/);
  return (match ? match[1] : value).trim();
}

/**
 * Resolves the RFC 5322 `From` header: the mailbox address keeps coming from
 * existing config (MAIL_FROM_ADDRESS, or parsed out of the legacy combined
 * MAIL_FROM), while the display name defaults to "Codestead" and can be
 * overridden separately via MAIL_FROM_NAME.
 */
export function resolveMailFrom(): string {
  const explicitAddress = process.env.MAIL_FROM_ADDRESS?.trim();
  const legacyMailFrom = process.env.MAIL_FROM?.trim();
  const name = process.env.MAIL_FROM_NAME?.trim() || DEFAULT_MAIL_FROM_NAME;

  const address = explicitAddress
    || (legacyMailFrom ? addressFromLegacyMailFrom(legacyMailFrom) : DEFAULT_MAIL_FROM_ADDRESS);

  if (!address || /[\r\n\0<>]/.test(address) || /[\r\n\0]/.test(name)) {
    throw new Error("MAIL_FROM configuration is invalid.");
  }

  return `${quoteDisplayName(name)} <${address}>`;
}
