import { CertificateManager } from "@/components/milestones/certificate-manager";
import { TrophyCabinet } from "@/components/milestones/trophy-cabinet";

export default function CertificatesPage() {
  return <div style={{ display: "grid", gap: 32 }}><CertificateManager /><TrophyCabinet /></div>;
}
