import { NextRequest, NextResponse } from "next/server";
import { CertificateError, loadOwnCertificate } from "@/lib/certificates/service";
import { renderCertificatePdf } from "@/lib/certificates/pdf";
import { requireAuth } from "@/lib/http/authz";
import { withRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" };

export async function GET(_request: NextRequest, { params }: { params: Promise<{ certificateId: string }> }) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "certificate_download_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      try {
        const certificate = await loadOwnCertificate((await params).certificateId, authz.session!.user.id);
        // Use the configured origin, never a caller-controlled Host header.
        const origin = process.env.APP_URL ?? (process.env.NODE_ENV === "production" ? undefined : "http://localhost:3000");
        if (!origin) throw new Error("Missing certificate verification origin");
        const base = new URL(origin);
        if (!["https:", "http:"].includes(base.protocol) || base.username || base.password) throw new Error("Invalid certificate verification origin");
        const verificationUrl = new URL(certificate.verificationPath, base.origin).href;
        const bytes = await renderCertificatePdf({ ...certificate, verificationUrl });
        return new NextResponse(Buffer.from(bytes), {
          headers: { ...noStore, "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="codestead-certificate-${certificate.verificationId}.pdf"` },
        });
      } catch (error) {
        if (error instanceof CertificateError && error.code === "NOT_FOUND") {
          return NextResponse.json({ error: "Certificate not found." }, { status: 404, headers: noStore });
        }
        return NextResponse.json({ error: "Certificate download is temporarily unavailable." }, { status: 503, headers: noStore });
      }
    },
  );
}
