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

export function apiFailure(error: unknown) {
  const status = error instanceof Error && "status" in error &&
    typeof error.status === "number" && Number.isInteger(error.status) &&
    error.status >= 400 && error.status <= 599
    ? error.status
    : error instanceof SyntaxError ? 400 : 500;
  const message = error instanceof Error && "status" in error
    ? error.message
    : status === 400 ? "La solicitud no es válida." : "No se pudo completar la operación.";
  return Response.json({ error: message }, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(error instanceof Error && "retryAfter" in error && typeof error.retryAfter === "number" &&
        Number.isInteger(error.retryAfter) && error.retryAfter > 0
        ? { "Retry-After": String(error.retryAfter) } : {}),
    },
  });
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const expectedOrigin = process.env.APP_URL
    ? new URL(process.env.APP_URL).origin
    : `${url.protocol}//${request.headers.get("host") ?? url.host}`;
  if (origin && origin !== expectedOrigin) {
    throw new OriginError("Origen no permitido");
  }
}
