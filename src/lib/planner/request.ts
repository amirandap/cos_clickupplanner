import { assertSameOrigin } from "@/lib/planner/http";
import { requireUser } from "@/lib/auth/require-user";
import { loadUserContext } from "@/lib/planner/context";

/** Every planner/settings handler starts here: CSRF check (mutations), session, then the user's context. */
export async function authorize(request: Request, options: { mutation: boolean }) {
  if (options.mutation) assertSameOrigin(request);
  const user = await requireUser(request);
  return { user, ctx: await loadUserContext(user.id) };
}
