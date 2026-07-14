import { SettingsView, type SettingsTab } from "@/components/product/settings-view";

const sections = new Set<SettingsTab>([
  "profile", "ai", "security", "privacy", "accessibility", "notifications", "device",
]);

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const { section } = await searchParams;
  const initialTab = sections.has(section as SettingsTab)
    ? (section as SettingsTab)
    : "ai";
  return <SettingsView initialTab={initialTab} />;
}
