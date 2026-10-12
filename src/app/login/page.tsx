"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Input } from "@/components/ui/primitives";

type AuthState = {
  authenticated: boolean;
  needsBootstrap: boolean;
};

/**
 * Only same-origin relative paths survive as a post-login destination; absolute
 * URLs, protocol-relative `//host` and backslash tricks fall back to the console
 * root, so the form cannot be abused as an open redirect.
 */
function safeNextPath(raw: string | null): string {
  if (!raw) return "/devices";
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return "/devices";
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\")) return "/devices";
  if (/[\u0000-\u001f]/.test(decoded)) return "/devices";
  return decoded;
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"password" | "code">("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [nextPath, setNextPath] = useState("/devices");

  useEffect(() => {
    const rawNext = new URLSearchParams(window.location.search).get("next");
    setNextPath(safeNextPath(rawNext));
    fetch("/api/auth")
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to check authentication status.");
        return (await response.json()) as { data: AuthState };
      })
      .then(({ data }) => {
        if (data.needsBootstrap) {
          setNotice("This installation is not bootstrapped. Run the bootstrap command on the server first.");
        }
        if (data.authenticated) router.replace(safeNextPath(rawNext));
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
      const body = mode === "password" ? { username, password } : { accessCode };
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "Sign-in failed.");
      router.replace(nextPath);
      router.refresh();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Sign-in failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <section className="panel w-full max-w-md p-5 sm:p-6">
        <div className="mb-6 space-y-1">
          <p className="micro-label">VWRAY CONTROL PLANE</p>
          <h1 className="text-xl font-semibold text-primary">Sign in</h1>
          <p className="text-[12.5px] leading-relaxed text-muted">
            {mode === "password"
              ? "Enter your operator username and password."
              : "Enter the installation access code."}
          </p>
        </div>

        <form className="space-y-4" onSubmit={submit}>
          {mode === "password" ? (
            <>
              <Field label="Username" htmlFor="username">
                <Input
                  id="username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  autoFocus
                  required
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="owner"
                />
              </Field>
              <Field label="Password" htmlFor="password">
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter password"
                />
              </Field>
            </>
          ) : (
            <Field label="Access code" htmlFor="access-code">
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
                placeholder="Enter access code"
              />
            </Field>
          )}

          {error ? <p className="text-[12px] text-danger" role="alert">{error}</p> : null}
          {notice ? <p className="text-[12px] text-warning" role="status">{notice}</p> : null}

          <Button variant="primary" size="lg" type="submit" disabled={submitting}>
            {submitting ? "Checking..." : "Continue"}
          </Button>

          <button
            type="button"
            className="block w-full text-center text-[12px] text-muted underline-offset-2 hover:text-primary hover:underline"
            onClick={() => {
              setMode((current) => (current === "password" ? "code" : "password"));
              setError(null);
            }}
          >
            {mode === "password" ? "Sign in with an access code instead" : "Sign in with a password instead"}
          </button>
        </form>
      </section>
    </main>
  );
}

