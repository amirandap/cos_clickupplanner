/** Provider errors carry a status without exposing upstream bodies or credentials. */
export class ProviderHttpError extends Error {
  readonly status = 502;
  /** OAuth `error` code (e.g. "invalid_grant") when the caller asked for it. Never the raw body. */
  errorCode?: string;
  constructor(public readonly provider: string, public readonly upstreamStatus: number, message?: string) {
    super(message ?? `${provider} API ${upstreamStatus}`);
    this.name = "ProviderHttpError";
  }
}

export class ProviderPayloadError extends Error {
  readonly status = 502;
  constructor(provider: string, detail: string) {
    super(`${provider}: respuesta inválida (${detail})`);
    this.name = "ProviderPayloadError";
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only callers with an idempotent operation may opt into a retry. */
export async function requestJson(
  provider: string,
  url: string,
  init: RequestInit = {},
  options: { retrySafe?: boolean; timeoutMs?: number; parseErrorCode?: boolean } = {},
): Promise<unknown> {
  const attempts = options.retrySafe ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
      if (!response.ok) {
        if (attempt + 1 < attempts && [429, 500, 502, 503, 504].includes(response.status)) {
          await response.body?.cancel();
          continue;
        }
        const failure = new ProviderHttpError(provider, response.status);
        if (options.parseErrorCode) {
          const body: unknown = await response.json().catch(() => null);
          if (record(body) && typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error)) failure.errorCode = body.error;
        } else await response.body?.cancel();
        throw failure;
      }
      if (response.status === 204) return undefined;
      try { return await response.json(); }
      catch { throw new ProviderPayloadError(provider, "JSON"); }
    } catch (error) {
      if (error instanceof ProviderHttpError || error instanceof ProviderPayloadError) throw error;
      if (controller.signal.aborted) throw new ProviderHttpError(provider, 504, `${provider}: tiempo de espera agotado`);
      if (attempt + 1 === attempts) throw new ProviderHttpError(provider, 502, `${provider}: no se pudo conectar`);
    } finally { clearTimeout(timer); }
  }
  throw new ProviderHttpError(provider, 502);
}
