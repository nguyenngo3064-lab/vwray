import { createRuntime } from "./agent.js";

async function main(): Promise<void> {
  const runtime = await createRuntime();
  await runtime.start();
  console.log(`[Node] registered with ${runtime.controlPlaneUrl} as ${runtime.nodeId ?? "unknown"}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[Node] startup failed:", message);
  process.exitCode = 1;
});
