import { appOrigin } from "@/lib/config/env";

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export class OriginError extends HttpError {
  constructor(message = "Origen no permitido") {
    super(403, message);
  }
}

export class UnauthorizedError extends HttpError {
  constructor() {
    super(401, "Se requiere autenticación.");
  }
}

/** A foreign resource is indistinguishable from a missing one. */
export class NotFoundError extends HttpError {
  constructor(message = "No encontrado") {
    super(404, message);
  }
}

export class RateLimitError extends HttpError {
  constructor(public readonly retryAfter: number) {
    super(429, "Demasiadas solicitudes. Intenta de nuevo en unos segundos.");
  }
}

/** A stored credential was revoked or expired for good; the user must reconnect it in Settings. */
export class ReconnectRequiredError extends HttpError {
  readonly code = "reconnect_required";
  constructor(public readonly provider: "google_calendar" | "clickup") {
    super(409, provider === "google_calendar"
      ? "Google Calendar se desconectó. Vuelve a conectarlo en Ajustes."
      : "El token de ClickUp ya no es válido. Pégalo de nuevo en Ajustes.");
  }
}

export function apiFailure(error: unknown) {
  const status = error instanceof Error && "status" in error &&
    typeof error.status === "number" && Number.isInteger(error.status) &&
    error.status >= 400 && error.status <= 599
    ? error.status
    : error instanceof SyntaxError ? 400 : 500;
  const message = error instanceof Error && "status" in error
    ? error.message
    : status === 400 ? "La solicitud no es válida." : "No se pudo completar la operación.";
  const code = error instanceof Error && "code" in error && error.code === "reconnect_required" ? { code: "reconnect_required" } : {};
  return Response.json({ error: message, ...code }, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(error instanceof Error && "retryAfter" in error && typeof error.retryAfter === "number" &&
        Number.isInteger(error.retryAfter) && error.retryAfter > 0
        ? { "Retry-After": String(error.retryAfter) } : {}),
    },
  });
}

/**
 * CSRF defence for every state-changing request. The Origin header must equal
 * APP_URL's origin. Browsers always send Origin on cross-origin and on POST/PUT/
 * PATCH/DELETE requests, so a missing Origin is accepted only when the browser
 * itself vouches for the request with Sec-Fetch-Site: same-origin.
 */
export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    if (origin !== appOrigin()) throw new OriginError("Origen no permitido");
    return;
  }
  if (request.headers.get("sec-fetch-site") === "same-origin") return;
  throw new OriginError("Origen no permitido");
}
