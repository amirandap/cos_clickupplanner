export class OriginError extends Error {}

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
