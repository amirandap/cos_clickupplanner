import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import SettingsForm from "@/components/settings-form";
import { userFromCookieStore } from "@/lib/auth/require-user";
import { settingsView } from "@/lib/settings/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ google?: string }> }) {
  const user = await userFromCookieStore(await cookies());
  if (!user) redirect("/login");
  const { google } = await searchParams;
  return <SettingsForm initial={await settingsView(user)} googleResult={typeof google === "string" ? google : null} />;
}
