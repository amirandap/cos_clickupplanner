import Planner from "@/components/planner";
import { readPlanner } from "@/lib/planner/read";

export const dynamic = "force-dynamic";

export default async function Home() {
  return <Planner initialData={await readPlanner()} />;
}
