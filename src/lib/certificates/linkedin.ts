import { SITE_URL } from "@/lib/site";

export function buildLinkedInCertificateUrl(certificate: {
  courseTitle: string;
  issuedAt: string;
  verificationId: string;
}, organizationName: string): string {
  const issuedAt = new Date(certificate.issuedAt);
  const url = new URL("https://www.linkedin.com/profile/add");
  url.search = new URLSearchParams({
    startTask: "CERTIFICATION_NAME",
    name: certificate.courseTitle,
    organizationName,
    issueYear: String(issuedAt.getUTCFullYear()),
    issueMonth: String(issuedAt.getUTCMonth() + 1),
    certUrl: new URL(`/verify/${encodeURIComponent(certificate.verificationId)}`, SITE_URL).href,
    certId: certificate.verificationId,
  }).toString();
  return url.href;
}
