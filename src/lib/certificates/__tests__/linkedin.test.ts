import { describe, expect, it } from "vitest";

import { buildLinkedInCertificateUrl } from "../linkedin";
import { SITE_URL } from "@/lib/site";

describe("LinkedIn certificate URL", () => {
  it("encodes every value and uses the canonical public verifier", () => {
    const href = buildLinkedInCertificateUrl({
      courseTitle: "Web & AI 日本語",
      issuedAt: "2026-07-14T00:00:00.000Z",
      verificationId: "token & 日本語",
    }, "Learning & Skills 学校");
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/profile/add");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      startTask: "CERTIFICATION_NAME",
      name: "Web & AI 日本語",
      organizationName: "Learning & Skills 学校",
      issueYear: "2026",
      issueMonth: "7",
      certUrl: `${SITE_URL}/verify/token%20%26%20%E6%97%A5%E6%9C%AC%E8%AA%9E`,
      certId: "token & 日本語",
    });
    expect(href).toContain("name=Web+%26+AI+%E6%97%A5%E6%9C%AC%E8%AA%9E");
    expect(href).toContain("organizationName=Learning+%26+Skills+%E5%AD%A6%E6%A0%A1");
    expect(href).toContain("certUrl=https%3A%2F%2F");
    expect(href).toContain("certId=token+%26+%E6%97%A5%E6%9C%AC%E8%AA%9E");
  });

  it("uses the issue month in UTC at year boundaries", () => {
    const url = new URL(buildLinkedInCertificateUrl({ courseTitle: "Python", verificationId: "opaque-id", issuedAt: "2026-01-01T00:30:00+01:00" }, "Codestead"));
    expect(url.searchParams.get("issueYear")).toBe("2025");
    expect(url.searchParams.get("issueMonth")).toBe("12");
  });
});
