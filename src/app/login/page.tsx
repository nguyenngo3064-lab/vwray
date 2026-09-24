"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input } from "@/components/ui/primitives";

type AuthState = {
  needsBootstrap: boolean;
  authenticated: boolean;
};

export default function LoginPage() {
  const router = useRouter();
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [accessCode, setAccessCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/auth")
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to check authentication status.");
        return (await response.json()) as { data: AuthState };
      })
      .then(({ data }) => {
        setAuth(data);
        if (data.authenticated) router.push("/devices");
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "Unable to check authentication status.");
      });
  }, [router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessCode }),
      });
      const payload = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "The access code is not valid.");
      router.push("/devices");
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "The access code is not valid.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <section className="panel w-full max-w-md p-5 sm:p-6">
        <div className="mb-6 space-y-1">
          <p className="micro-label">VWRAY CONTROL PLANE</p>
          <h1 className="text-xl font-semibold text-primary">Access console</h1>
          <p className="text-[12.5px] leading-relaxed text-muted">
            Enter the password for this installation.
          </p>
        </div>

        {auth?.needsBootstrap ? (
          <p className="mb-4 text-[12px] leading-relaxed text-warning">
            This installation has not been bootstrapped yet. Generate the first access code on the server, then return here.
          </p>
        ) : null}

        <form className="space-y-4" onSubmit={submit}>
          <Field label="Password" htmlFor="access-code" hint="Development default: admin9785">
            <Input
              id="access-code"
              name="accessCode"
              type="password"
              autoComplete="off"
              autoFocus
              required
              minLength={4}
              value={accessCode}
              onChange={(event) => setAccessCode(event.target.value)}
              placeholder="Enter password"
            />
          </Field>
          {error ? <p className="text-[12px] text-danger" role="alert">{error}</p> : null}
          <Button variant="primary" size="lg" type="submit" disabled={submitting}>
            {submitting ? "Checking..." : "Continue"}
          </Button>
        </form>
      </section>
    </main>
  );
}