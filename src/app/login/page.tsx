import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { userFromCookieStore } from "@/lib/auth/require-user";

export const dynamic = "force-dynamic";

// Only these fixed codes are ever rendered, never text taken from the URL.
const MESSAGES: Record<string, string> = {
  invalid_state: "La sesión de inicio caducó o no es válida. Inténtalo de nuevo.",
  denied: "Cancelaste el acceso con Google.",
  unverified: "Tu cuenta de Google no tiene el correo verificado.",
  domain: "Esta cuenta de Google no tiene permiso para entrar a esta instancia.",
  failed: "No se pudo iniciar sesión con Google. Inténtalo de nuevo.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await userFromCookieStore(await cookies())) redirect("/");
  const { error } = await searchParams;
  const message = error && Object.hasOwn(MESSAGES, error) ? MESSAGES[error] : null;
  return <main className="mx-auto flex min-h-screen max-w-sm items-center px-4">
    <Card className="w-full">
      <CardHeader>
        <CardTitle>ClickUp Planner</CardTitle>
        <CardDescription>Inicia sesión con Google para ver tus tareas y tu calendario.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {message && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{message}</p>}
        <a href="/api/auth/login/google" className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80">Entrar con Google</a>
      </CardContent>
    </Card>
  </main>;
}
