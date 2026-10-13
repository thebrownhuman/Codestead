import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CertificateVerifier } from "@/components/milestones/certificate-verifier";
import { CertificateError, loadPublicCertificate } from "@/lib/certificates/service";

export const dynamic = "force-dynamic";
export function generateMetadata(): Metadata {
  // Generic metadata avoids disclosing identity in crawler previews or caches.
  const title = "Certificate verification | Codestead";
  const description = "Check a Codestead certificate's course, issue date and current validity.";
  return {
    title, description,
    robots: { index: false, follow: false, noarchive: true },
    openGraph: { title, description, type: "website", images: [] },
  };
}

export default async function VerifyCertificatePage({ params }: { readonly params: Promise<{ verificationId: string }> }) {
  let certificate: Awaited<ReturnType<typeof loadPublicCertificate>>;
  try { certificate = await loadPublicCertificate((await params).verificationId); }
  catch (error) {
    if (error instanceof CertificateError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
  return <CertificateVerifier certificate={certificate} />;
}
