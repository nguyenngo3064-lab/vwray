import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  createNodeName,
  detectCapabilities,
  detectPort,
  detectPublicEndpoint,
  readEnv,
  resolveNodeProtocol,
} from "./config.js";

export type NodeStatus = "STARTING" | "REGISTERING" | "AUTHENTICATING" | "HEARTBEAT" | "ONLINE" | "OFFLINE" | "REVOKED";

export interface NodeRegistrationPayload {
  name: string;
  location: string;
  publicEndpoint: string;
  port: number;
  protocol: string;
  capabilities: string[];
  isRealGateway: boolean;
}

export interface StoredCredentials {
  nodeId: string;
  nodeToken: string;
  name: string;
  createdAt: string;
}

export interface NodeRuntimeOptions {
  controlPlaneUrl?: string;
  nodeName?: string;
  location?: string;
  protocol?: string;
  port?: number;
  logPrefix?: string;
  credentialPath?: string;
}

export interface NodeRuntime {
  status: NodeStatus;
  port: number;
  publicEndpoint: string | null;
  controlPlaneUrl: string;
  nodeId: string | null;
  nodeToken: string | null;
  capabilities: string[];
  readState(): { status: NodeStatus; port: number; publicEndpoint: string | null; controlPlaneUrl: string; nodeId: string | null; nodeToken: string | null; capabilities: string[]; };
  start(): Promise<void>;
  registerIfNeeded(): Promise<void>;
  sendHeartbeat(): Promise<void>;
}

function defaultCredentialPath(): string {
  return join(homedir(), ".config", "vwray-node", "credentials.json");
}

export async function loadCredentials(path = defaultCredentialPath()): Promise<StoredCredentials | null> {
  try {
    const file = await readFile(path, "utf8");
    const value = JSON.parse(file) as Partial<StoredCredentials>;
    if (value.nodeId && value.nodeToken && value.name) {
      return {
        nodeId: value.nodeId,
        nodeToken: value.nodeToken,
        name: value.name,
        createdAt: value.createdAt ?? new Date().toISOString(),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export async function saveCredentials(credentials: StoredCredentials, path = defaultCredentialPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(credentials, null, 2), { encoding: "utf8", mode: 0o600 });
}

function getControlPlaneUrl(input?: string): string {
  const env = readEnv();
  const raw = input ?? env.CONTROL_PLANE_URL ?? env.VWRAY_CONTROL_PLANE_URL ?? "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

function normalizeNodeLocation(input?: string): string {
  const env = readEnv();
  return (input ?? env.NODE_LOCATION ?? "local").trim() || "local";
}

function normalizeProtocol(input?: string, supportsWireGuard = false): string {
  const env = readEnv();
  const value = input ?? env.NODE_PROTOCOL ?? "";
  return resolveNodeProtocol({ ...env, NODE_PROTOCOL: value }, supportsWireGuard);
}

function detectSupportForWireguard(): boolean {
  const env = readEnv();
  if (env.NODE_PROTOCOL && env.NODE_PROTOCOL.toUpperCase() === "WIREGUARD") return true;
  try {
    return existsSync("/proc/net/wireguard") || existsSync("/etc/wireguard");
  } catch {
    return false;
  }
}

function jsonHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  headers["x-vwray-timestamp"] = String(Math.floor(Date.now() / 1000));
  return headers;
}

export async function createRuntime(options: NodeRuntimeOptions = {}): Promise<NodeRuntime> {
  const env = readEnv();
  const port = options.port ?? detectPort(env);
  const controlPlaneUrl = getControlPlaneUrl(options.controlPlaneUrl);
  const publicEndpoint = detectPublicEndpoint(env, port) ?? `http://localhost:${port}`;
  const capabilities = detectCapabilities(detectSupportForWireguard());
  const runtime: NodeRuntime = {
    status: "STARTING",
    port,
    publicEndpoint,
    controlPlaneUrl,
    nodeId: null,
    nodeToken: null,
    capabilities,
    readState() {
      return {
        status: runtime.status,
        port: runtime.port,
        publicEndpoint: runtime.publicEndpoint,
        controlPlaneUrl: runtime.controlPlaneUrl,
        nodeId: runtime.nodeId,
        nodeToken: runtime.nodeToken,
        capabilities: runtime.capabilities,
      };
    },
    async start() {
      const creds = await loadCredentials(options.credentialPath ?? defaultCredentialPath());
      if (creds) {
        runtime.nodeId = creds.nodeId;
        runtime.nodeToken = creds.nodeToken;
        runtime.status = "AUTHENTICATING";
      } else {
        runtime.status = "REGISTERING";
        await runtime.registerIfNeeded();
      }

      const server = createServer(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname === "/health") {
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ status: "ok", service: "vwray-node", online: runtime.status === "ONLINE" }));
          return;
        }
        if (url.pathname === "/ready") {
          response.writeHead(runtime.status === "ONLINE" ? 200 : 503, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ status: runtime.status, ready: runtime.status === "ONLINE", service: "vwray-node" }));
          return;
        }
        response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ status: "not_found" }));
      });

      server.listen(port, "0.0.0.0", () => {
        console.log(`[Node] listening on ${port} and reporting as ${runtime.status}`);
      });

      await new Promise<void>((resolve) => {
        server.once("listening", resolve);
      });

      setInterval(() => {
        void runtime.sendHeartbeat().catch((error: unknown) => {
          runtime.status = "OFFLINE";
          console.error("[Node] heartbeat failed:", error instanceof Error ? error.message : String(error));
        });
      }, Number(env.HEARTBEAT_INTERVAL_MS ?? 15000));

      await runtime.sendHeartbeat();
    },
    async registerIfNeeded() {
      const env = readEnv();
      const state = await loadCredentials(options.credentialPath ?? defaultCredentialPath());
      if (state?.nodeId && state.nodeToken) {
        runtime.nodeId = state.nodeId;
        runtime.nodeToken = state.nodeToken;
        runtime.status = "AUTHENTICATING";
        return;
      }

      const nodeName = createNodeName(env);
      const payload: NodeRegistrationPayload = {
        name: options.nodeName ?? nodeName,
        location: normalizeNodeLocation(options.location),
        publicEndpoint: detectPublicEndpoint(env, port) ?? `http://localhost:${port}`,
        port,
        protocol: normalizeProtocol(options.protocol, detectSupportForWireguard()),
        capabilities,
        isRealGateway: detectSupportForWireguard(),
      };

      const response = await fetch(new URL("/api/nodes", controlPlaneUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Node registration failed (${response.status}): ${body}`);
      }

      const data = (await response.json()) as {
        node?: { nodeId?: string; id?: string };
        agentToken?: string;
      };
      const token = data.agentToken;
      const nodeId = data.node?.nodeId ?? data.node?.id ?? `node-${randomUUID().slice(0, 8)}`;
      if (!token) {
        throw new Error("Control plane registration did not include an agent token.");
      }

      const credentials: StoredCredentials = {
        nodeId,
        nodeToken: token,
        name: payload.name,
        createdAt: new Date().toISOString(),
      };
      await saveCredentials(credentials, options.credentialPath ?? defaultCredentialPath());
      runtime.nodeId = nodeId;
      runtime.nodeToken = token;
      runtime.status = "AUTHENTICATING";
    },
    async sendHeartbeat() {
      const token = runtime.nodeToken;
      if (!token || !runtime.nodeId) {
        await runtime.registerIfNeeded();
      }

      const currentToken = runtime.nodeToken;
      if (!currentToken || !runtime.nodeId) {
        runtime.status = "OFFLINE";
        return;
      }

      runtime.status = "HEARTBEAT";
      const heartbeatUrl = new URL("/api/gateway/heartbeat", runtime.controlPlaneUrl).toString();
      const payload = {
        version: "vwray-node/0.1.0",
        agentVersion: "0.1.0",
        cpuPercent: 0,
        ramPercent: 0,
        bandwidthMbps: 0,
        activeSessions: 0,
        latencyMs: 0,
        jitterMs: 0,
        packetLossPct: 0,
      };

      const response = await fetch(heartbeatUrl, {
        method: "POST",
        headers: jsonHeaders(currentToken),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Heartbeat failed (${response.status}): ${detail}`);
      }

      runtime.status = "ONLINE";
      runtime.publicEndpoint = detectPublicEndpoint(readEnv(), runtime.port) ?? runtime.publicEndpoint;
    },
  };

  return runtime;
}

export function createNodeServer() {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ status: "ok", service: "vwray-node" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ status: "not_found" }));
  });
}
