import { NextRequest, NextResponse } from "next/server";
import { authorizeRequest } from "@/lib/auth";

export function proxy(request: NextRequest) {
  const authorization = authorizeRequest(request);
  if (authorization.allowed) return NextResponse.next();

  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (authorization.status === 401) {
    headers["WWW-Authenticate"] = 'Basic realm="ClickUp Planner", charset="UTF-8"';
  }
  const error = authorization.status === 401
    ? "Se requiere autenticación."
    : "El acceso a esta instancia todavía no está configurado.";
  return request.nextUrl.pathname.startsWith("/api/")
    ? NextResponse.json({ error }, { status: authorization.status, headers })
    : new NextResponse(error, { status: authorization.status, headers });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
