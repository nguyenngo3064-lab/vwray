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
  nodeId: string;
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
  lastHeartbeatAt: string | null;
  capabilities: string[];
  readState(): { status: NodeStatus; port: number; publicEndpoint: string | null; controlPlaneUrl: string; nodeId: string | null; nodeToken: string | null; capabilities: string[]; };
  start(): Promise<void>;
  registerIfNeeded(): Promise<void>;
  sendHeartbeat(): Promise<void>;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const INITIAL_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 30_000;

function defaultCredentialPath(): string {
  return join(homedir(), ".config", "vwray-node", "credentials.json");
}

async function stableNodeId(path: string): Promise<string> {
  const existing = await loadCredentials(path);
  if (existing?.nodeId) return existing.nodeId;
  return process.env.NODE_ID?.trim() || `node-${randomUUID()}`;
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

function log(runtime: NodeRuntime, message: string): void {
  console.info(`[vwray-node] ${message}`);
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
  const publicEndpoint = detectPublicEndpoint(env, port);
  const capabilities = detectCapabilities(detectSupportForWireguard());
  const runtime: NodeRuntime = {
    status: "STARTING",
    port,
    publicEndpoint,
    controlPlaneUrl,
    nodeId: null,
    nodeToken: null,
    lastHeartbeatAt: null,
    capabilities,
    readState() {
      return {
        status: runtime.status,
        port: runtime.port,
        publicEndpoint: runtime.publicEndpoint,
        controlPlaneUrl: runtime.controlPlaneUrl,
        nodeId: runtime.nodeId,
        nodeToken: runtime.nodeToken,
        lastHeartbeatAt: runtime.lastHeartbeatAt,
        capabilities: runtime.capabilities,
      };
    },
    async start() {
      const credentialPath = options.credentialPath ?? defaultCredentialPath();
      log(runtime, "Starting");
      log(runtime, `Control Plane: ${env.CONTROL_PLANE_URL || env.VWRAY_CONTROL_PLANE_URL ? "configured" : "defaulted"}`);
      log(runtime, `Port: ${port}`);
      const creds = await loadCredentials(credentialPath);
      if (creds) {
        runtime.nodeId = creds.nodeId;
        runtime.nodeToken = creds.nodeToken;
        runtime.status = "AUTHENTICATING";
      } else {
        runtime.status = "REGISTERING";
      }

      const server = createServer(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname === "/health") {
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({
            status: runtime.status,
            service: "vwray-node",
            online: runtime.status === "ONLINE",
            nodeId: runtime.nodeId,
            port: runtime.port,
            lastHeartbeatAt: runtime.lastHeartbeatAt,
          }));
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
        log(runtime, `Listening on ${port} and reporting as ${runtime.status}`);
      });

      await new Promise<void>((resolve) => {
        server.once("listening", resolve);
      });

      const heartbeatInterval = Number(env.HEARTBEAT_INTERVAL_MS ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
      let retryDelay = INITIAL_RETRY_DELAY_MS;
      const heartbeatLoop = async (): Promise<void> => {
        try {
          if (!runtime.nodeToken || !runtime.nodeId) {
            log(runtime, "Registering...");
            await runtime.registerIfNeeded();
            log(runtime, "Registered");
            log(runtime, "Heartbeat started");
          }
          await runtime.sendHeartbeat();
          retryDelay = INITIAL_RETRY_DELAY_MS;
          if (runtime.status === "ONLINE") log(runtime, "ONLINE");
          setTimeout(() => void heartbeatLoop(), heartbeatInterval);
        } catch (error: unknown) {
          runtime.status = "OFFLINE";
          console.error("[vwray-node] connection failed:", error instanceof Error ? error.message : String(error));
          setTimeout(() => void heartbeatLoop(), retryDelay);
          retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
        }
      };
      void heartbeatLoop();
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
        nodeId: await stableNodeId(options.credentialPath ?? defaultCredentialPath()),
        name: options.nodeName ?? nodeName,
        location: normalizeNodeLocation(options.location),
        publicEndpoint: detectPublicEndpoint(env, port) ?? "",
        port,
        protocol: normalizeProtocol(options.protocol, detectSupportForWireguard()),
        capabilities,
        isRealGateway: detectSupportForWireguard(),
      };

      if (!payload.publicEndpoint) {
        throw new Error("REGISTRATION_FAILED: PUBLIC_ENDPOINT or RAILWAY_PUBLIC_DOMAIN is required in production.");
      }

      const response = await fetch(new URL("/api/nodes/register", controlPlaneUrl).toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-vwray-enrollment-token": env.NODE_ENROLLMENT_TOKEN ?? "",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Node registration failed (${response.status}): ${body}`);
      }

      const envelope = (await response.json()) as { data?: {
        node?: { nodeId?: string; id?: string };
        agentToken?: string;
      } };
      const data = envelope.data ?? {};
      const token = data.agentToken;
      const nodeId = data.node?.nodeId ?? data.node?.id ?? payload.nodeId;
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
        if (response.status === 401 || response.status === 403) {
          runtime.nodeId = null;
          runtime.nodeToken = null;
          runtime.status = "REGISTERING";
        }
        throw new Error(`Heartbeat failed (${response.status}): ${detail}`);
      }

      runtime.status = "ONLINE";
      runtime.lastHeartbeatAt = new Date().toISOString();
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
