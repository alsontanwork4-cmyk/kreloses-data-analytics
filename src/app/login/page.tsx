import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { HOME_PATH, isLoginError, LOGIN_ERROR_MESSAGES, safeNextPath } from "@/auth/paths";
import { getAccess } from "@/auth/session";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

/** Public. Already signed in and allow-listed → straight to the dashboard. */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = safeNextPath(params.next) ?? undefined;

  const access = await getAccess();
  if (access.status === "allowed") redirect(next ?? HOME_PATH);

  const error = isLoginError(params.error) ? LOGIN_ERROR_MESSAGES[params.error] : null;

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">
            <h1>Kreloses Analytics</h1>
          </CardTitle>
          <CardDescription>Sign in with the email address you were invited with.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <LoginForm next={next} />
        </CardContent>
      </Card>
    </main>
  );
}
