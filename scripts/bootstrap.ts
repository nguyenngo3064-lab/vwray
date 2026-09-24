async function main() {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(".env");
  }

  const baseUrl = process.env.APP_URL ?? "http://localhost:3000";
  const response = await fetch(`${baseUrl}/api/auth/bootstrap`, { method: "POST" });
  const payload = (await response.json()) as {
    data?: { created?: boolean; username?: string; accessCode?: string };
    error?: { message?: string };
    requestId?: string;
  };

  if (!response.ok) {
    const requestId = payload.requestId ? ` (request ${payload.requestId})` : "";
    throw new Error(
      `${payload.error?.message ?? `Bootstrap request failed with HTTP ${response.status}.`}${requestId}`,
    );
  }

  if (!payload.data?.created) {
    console.log("Bootstrap skipped: an operator account already exists.");
    return;
  }

  console.log(`Bootstrap complete. Username: ${payload.data.username}`);
  console.log(`Access code (shown once): ${payload.data.accessCode}`);
}

main().catch((error: unknown) => {
  console.error("Bootstrap failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});