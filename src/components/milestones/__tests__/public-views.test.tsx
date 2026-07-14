import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CertificateVerifier } from "../certificate-verifier";
import { PublicPortfolioView } from "../public-portfolio-view";

describe("public milestone views", () => {
  it("renders a learner-selected portfolio and its disclosure boundary", () => {
    const { container } = render(<PublicPortfolioView portfolio={{
      slug: "safe-learner",
      displayName: "Safe Learner",
      headline: "Building verified projects",
      about: "Learning in public.",
      publishedAt: "2026-07-14T00:00:00.000Z",
      projects: [{ id: "project-1", title: "Public project", summary: "A bounded summary", status: "complete", githubUrl: "https://github.com/safe/project" }],
      achievements: [{ id: "award-1", title: "Python complete", description: "Verified", icon: "award" }],
      certificates: [{ id: "certificate-1", title: "Python foundations", version: "1.0.0", issuedAt: "2026-07-14T00:00:00.000Z", verificationPath: "/verify/public-token" }],
      privacyNotice: "This page excludes email, scores, attempts, activity, study time, code, chat, and provider data.",
    }} />);
    expect(screen.getByRole("heading", { name: "Safe Learner" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open github repository/i })).toHaveAttribute("href", "https://github.com/safe/project");
    expect(screen.getByText(/excludes email, scores/i)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/must-not-leak@example|revocation reason|evidence hash/i);
  });

  it("shows a revoked verifier state without a private administrative reason", () => {
    const { container } = render(<CertificateVerifier certificate={{
      verificationId: "public-token",
      learnerDisplayName: "Safe Learner",
      courseTitle: "Python foundations",
      courseVersion: "1.0.0",
      issuedAt: "2026-07-14T00:00:00.000Z",
      status: "revoked",
      revokedAt: "2026-07-15T00:00:00.000Z",
      statement: "This certificate has been revoked. The private administrative reason is not exposed by the public verifier.",
    }} />);
    expect(screen.getByText("revoked")).toBeInTheDocument();
    expect(screen.getByText(/reason is not exposed/i)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/verified integrity correction|admin-1|learner@example/i);
  });
});
