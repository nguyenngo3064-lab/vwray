import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";

/**
 * SSE transport for the console.
 *
 * Why SSE and not WebSocket: the stream is strictly server -> browser, it survives
 * ordinary HTTP proxies and platform load balancers unchanged, and browsers reconnect
 * it natively. A WebSocket would buy nothing here and would need an upgrade path that
 * several PaaS platforms do not expose.
 *
 * Frame contract (mirrored by src/lib/realtime/types.ts):
 *   event: hello         data: { tick, serverTime, windows }
 *   event: tick          data: TrafficTick            (1 Hz)
 *   event: ping          data: { ts }                 (keepalive + latency probe)
 *   event: notification | quota.update | device.update | node.update
 *
 * IMPORTANT: this endpoint is authenticated with the session cookie. `EventSource`
 * sends same-origin cookies, so a dropped session correctly terminates the stream
 * instead of leaving a background socket feeding a signed-out browser.
 */

export const GET = withConsole(
  async (_request, ctx) => {
    const { getEnv } = await import("@/server/config/env");
    const { aggregator } = await import("@/server/realtime/aggregator");
    const { subscribe } = await import("@/server/realtime/bus");

    const env = getEnv();
    const encoder = new TextEncoder();
    let closed = false;
    const unsubscribe: Array<() => void> = [];
    let keepalive: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown): void => {
          if (closed) return;
          try {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          } catch {
            // The client went away between the check and the enqueue; treat as closed.
            closed = true;
          }
        };

        send("hello", {
          tick: aggregator.hello(),
          serverTime: Date.now(),
          windows: env.realtimeWindows,
        });

        unsubscribe.push(subscribe("traffic.tick", (tick) => send("tick", tick)));
        unsubscribe.push(subscribe("notification", (payload) => send("notification", payload)));
        unsubscribe.push(subscribe("quota.update", (payload) => send("quota.update", payload)));
        unsubscribe.push(subscribe("device.update", (payload) => send("device.update", payload)));
        unsubscribe.push(subscribe("node.update", (payload) => send("node.update", payload)));

        // Keepalive doubles as the latency probe: the hook timestamps `ping` and
        // measures the round trip when the frame arrives.
        keepalive = setInterval(() => send("ping", { ts: Date.now() }), 15_000);
      },
      cancel() {
        closed = true;
        if (keepalive) clearInterval(keepalive);
        while (unsubscribe.length > 0) unsubscribe.pop()?.();
      },
    });

    // Give the request an id so a stream failure can be correlated with the logs.
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Disable proxy buffering so frames are not held until a buffer fills.
        "X-Accel-Buffering": "no",
        "X-Request-Id": ctx.requestId,
      },
    });
  },
  { rateLimit: { limit: 30, windowSeconds: 60 } },
);

export const dynamic = "force-dynamic";
