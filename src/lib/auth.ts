import { createHash, timingSafeEqual } from "node:crypto";

type Authorization = { allowed: true } | { allowed: false; status: 401 | 503 };

function sameCredential(actual: string, expected: string) {
  return timingSafeEqual(
    createHash("sha256").update(actual).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

export function authorizeRequest(request: Request): Authorization {
  const username = process.env.PLANNER_AUTH_USERNAME;
  const password = process.env.PLANNER_AUTH_PASSWORD;
  if (!username || !password) {
    if (process.env.USE_MOCK_DATA === "true" && !username && !password) {
      return { allowed: true };
    }
    return { allowed: false, status: 503 };
  }

  const header = request.headers.get("authorization") ?? "";
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!match || match[1].length > 8192) return { allowed: false, status: 401 };
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return { allowed: false, status: 401 };
  const validUser = sameCredential(decoded.slice(0, separator), username);
  const validPassword = sameCredential(decoded.slice(separator + 1), password);
  return validUser && validPassword
    ? { allowed: true }
    : { allowed: false, status: 401 };
}
