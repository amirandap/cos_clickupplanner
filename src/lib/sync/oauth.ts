import { NextRequest, NextResponse } from "next/server";

export function appUrl() { return process.env.APP_URL || "http://localhost:3000"; }
export function stateCookie(provider: string) { return `planner_oauth_${provider}`; }
export function beginOAuth(provider: string, target: URL) {
  const state = crypto.randomUUID();
  target.searchParams.set("state", state);
  const response = NextResponse.redirect(target);
  response.cookies.set(stateCookie(provider), state, { httpOnly: true, sameSite: "lax", secure: appUrl().startsWith("https:"), maxAge: 600, path: "/" });
  return response;
}
export function validateOAuth(request: NextRequest, provider: string) {
  const expected = request.cookies.get(stateCookie(provider))?.value;
  const received = request.nextUrl.searchParams.get("state");
  if (!expected || !received || expected !== received) throw new Error("Estado OAuth inválido");
  const code = request.nextUrl.searchParams.get("code");
  if (!code) throw new Error("No se recibió código OAuth");
  return code;
}
export function finishOAuth(provider: string, error?: string) {
  const url = new URL(appUrl());
  url.searchParams.set(provider, error ? "error" : "connected");
  if (error) url.searchParams.set("message", error);
  const response = NextResponse.redirect(url);
  response.cookies.delete(stateCookie(provider));
  return response;
}
