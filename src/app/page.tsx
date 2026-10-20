import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Planner from "@/components/planner";
import { readPlanner } from "@/lib/planner/read";
import { userFromCookieStore } from "@/lib/auth/require-user";
import { loadUserContext } from "@/lib/planner/context";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await userFromCookieStore(await cookies());
  if (!user) redirect("/login");
  const data = await readPlanner(await loadUserContext(user.id));
  return <Planner initialData={data} userEmail={user.email} />;
}
