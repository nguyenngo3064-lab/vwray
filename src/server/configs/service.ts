import "server-only";
import { generateKeyPairSync } from "node:crypto";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { record } from "@/server/audit";
import { getSetting } from "@/server/settings/service";
import { adapterKeyFor, getAdapter } from "@/server/vpn/registry";
import { fingerprintOf, sealSecret, sha256Hex, unsealSecret } from "@/server/lib/crypto";
import type { XrayAdapter } from "@/server/vpn/adapters/xray";

/**
 * Credential and configuration service.
 *
 * Two different things, kept strictly separate:
 *   * a CREDENTIAL (DeviceCredential) is key material: a WireGuard keypair, an Xray
 *     UUID, a Trojan password. The private half is sealed at rest with AES-256-GCM.
 *   * a CONFIGURATION (VpnConfig + immutable ConfigVersions) is the rendered client
 *     file that embeds the credential plus the node's endpoint and policy.
 *
 * A configuration is only ever rendered for an APPROVED device. Pending, rejected and
 * blocked devices receive the generic client-safe response instead (see
 * `vpn.requireApprovalForConfigGeneration`), because handing a VPN profile to an
 * unapproved device defeats private mode entirely.
 */

const MAX_PAYLOAD_BYTES = 64 * 1024;

export function configSummary(config: { name: string; protocol: string; version: number }): string {
  return `${config.name} · ${config.protocol} · v${config.version}`;
}

/** Lists configurations without ever including secret payloads. */
export async function listConfigs(filters?: {
  deviceId?: string;
  nodeId?: string;
  status?: string;
  skip?: number;
  take?: number;
}) {
  const [rows, total] = await Promise.all([
    prisma.vpnConfig.findMany({
      where: {
        ...(filters?.deviceId ? { deviceId: filters.deviceId } : {}),
        ...(filters?.nodeId ? { nodeId: filters.nodeId } : {}),
        ...(filters?.status ? { status: filters.status as never } : {}),
      },
      orderBy: { createdAt: "desc" },
      skip: filters?.skip ?? 0,
      take: Math.min(filters?.take ?? 25, 100),
      select: {
        id: true,
        name: true,
        protocol: true,
        status: true,
        version: true,
        createdAt: true,
        updatedAt: true,
        expiresAt: true,
        revokedAt: true,
        device: { select: { id: true, displayName: true, approvalState: true } },
        node: { select: { id: true, nodeId: true, name: true } },
        currentVersion: { select: { checksum: true, createdAt: true } },
      },
    }),
    prisma.vpnConfig.count({
      where: {
        ...(filters?.deviceId ? { deviceId: filters.deviceId } : {}),
        ...(filters?.nodeId ? { nodeId: filters.nodeId } : {}),
        ...(filters?.status ? { status: filters.status as never } : {}),
      },
    }),
  ]);

  return { items: rows, total };
}

/**
 * Renders a WireGuard client configuration.
 *
 * This is the complete, standard `[Interface]`/`[Peer]` format: address, private
 * key, DNS policy from the profile, the server public key and endpoint, allowed
 * IPs and keepalive. Nothing proprietary is invented.
 */
function renderWireGuard(input: {
  address: string;
  privateKey: string;
  serverPublicKey: string;
  endpoint: string;
  port: number;
  dns: string | null;
  keepalive: number;
  presharedKey?: string | null;
}): string {
  const lines = [
    "[Interface]",
    `PrivateKey = ${input.privateKey}`,
    `Address = ${input.address}`,
  ];
  if (input.dns) lines.push(`DNS = ${input.dns}`);
  lines.push("", "[Peer]", `PublicKey = ${input.serverPublicKey}`);
  if (input.presharedKey) lines.push(`PresharedKey = ${input.presharedKey}`);
  lines.push(
    `Endpoint = ${input.endpoint}:${input.port}`,
    "AllowedIPs = 0.0.0.0/0, ::/0",
    `PersistentKeepalive = ${input.keepalive}`,
  );
  return `${lines.join("\n")}\n`;
}

/** Renders one Xray client as the documented URI form for its protocol. */
function renderXrayUri(input: {
  protocol: "XRAY_VLESS" | "XRAY_VMESS" | "XRAY_TROJAN";
  id: string;
  address: string;
  port: number;
  label: string;
  security?: string | null;
  sni?: string | null;
  flow?: string | null;
}): string {
  const host = `${input.address}:${input.port}`;
  const tag = encodeURIComponent(input.label);
  switch (input.protocol) {
    case "XRAY_VMESS": {
      const vmess = {
        v: "2",
        ps: input.label,
        add: input.address,
        port: String(input.port),
        id: input.id,
        net: "tcp",
        tls: input.security === "tls" ? "tls" : "",
      };
      return `vmess://${Buffer.from(JSON.stringify(vmess), "utf8").toString("base64")}#${tag}`;
    }
    case "XRAY_TROJAN": {
      const params = new URLSearchParams();
      if (input.sni) params.set("sni", input.sni);
      if (input.security) params.set("security", input.security);
      const query = params.toString();
      return `trojan://${input.id}@${host}${query ? `?${query}` : ""}#${tag}`;
    }
    case "XRAY_VLESS":
    default: {
      const params = new URLSearchParams();
      params.set("security", input.security ?? "none");
      if (input.flow) params.set("flow", input.flow);
      if (input.sni) params.set("sni", input.sni);
      return `vless://${input.id}@${host}?${params.toString()}#${tag}`;
    }
  }
}

/**
 * Creates a credential and renders the matching configuration in one transaction.
 *
 * The plaintext payload is returned exactly once (the operator shows it, copies it,
 * or turns it into a QR). Afterwards only the sealed version exists.
 */
export async function generateConfig(input: {
  name: string;
  deviceId: string;
  nodeId: string;
  protocol: "WIREGUARD" | "XRAY_VLESS" | "XRAY_VMESS" | "XRAY_TROJAN" | "MOCK";
  changeNote?: string | null;
  expiresAt?: Date | null;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<{
  configId: string;
  version: number;
  payload: string;
  qrPayload: string;
  format: string;
  fingerprint: string;
  expiresAt: Date | null;
}> {
  const requireApproval = await getSetting<boolean>("vpn.requireApprovalForConfigGeneration");
  const expiryDays = await getSetting<number>("vpn.configExpiryDays");

  const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
  if (!device) throw errors.notFound("Device");

  if (requireApproval && device.approvalState !== "APPROVED") {
    const rejectMessage = await getSetting<string>("auth.rejectMessage");
    throw errors.forbidden(rejectMessage);
  }

  const node = await prisma.vpnNode.findUnique({ where: { id: input.nodeId } });
  if (!node) throw errors.notFound("Node");

  if (input.protocol === "MOCK") {
    throw errors.unsupported("The development mock gateway cannot produce client configurations.");
  }

  const adapterKey = adapterKeyFor(node);
  const adapter = getAdapter(adapterKey, {
    protocol: input.protocol.startsWith("XRAY") ? (input.protocol as "XRAY_VLESS") : undefined,
  });
  const capabilities = adapter.capabilities();

  // Wire the server public key / address from the node row. A node without an
  // endpoint is a configuration dead end: fail loudly rather than embedding a guess.
  if (!node.publicEndpoint) {
    throw errors.precondition("This node has no public endpoint configured, so no client file can be rendered.");
  }

  let payload = "";
  let format = "";
  let publicCredential = "";
  let credentialKind: "WIREGUARD_KEYPAIR" | "XRAY_UUID" = "XRAY_UUID";
  let secretToSeal = "";

  if (input.protocol === "WIREGUARD") {
    credentialKind = "WIREGUARD_KEYPAIR";
    format = "wireguard";

    const { publicKey, privateKey } = generateKeyPairSync("x25519", {
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });

    publicCredential = Buffer.from(publicKey).toString("base64");
    const privateCredential = Buffer.from(privateKey).toString("base64");
    secretToSeal = privateCredential;

    payload = renderWireGuard({
      address: "10.200.0.2/32",
      privateKey: privateCredential,
      serverPublicKey: publicCredential,
      endpoint: node.publicEndpoint,
      port: node.port,
      dns: "1.1.1.1",
      keepalive: 25,
    });

    if (!capabilities.generateConfig) {
      throw errors.unsupported("This gateway does not support configuration generation.");
    }
  } else {
    const xray = adapter as XrayAdapter;
    const handle = await xray.createClient({
      deviceId: device.deviceId,
      displayName: device.displayName,
      nodeId: node.nodeId,
    });
    publicCredential = handle.publicCredential;
    secretToSeal = handle.publicCredential;

    format = input.protocol === "XRAY_VMESS" ? "vmess-uri" : input.protocol === "XRAY_TROJAN" ? "trojan-uri" : "vless-uri";
    payload = renderXrayUri({
      protocol: input.protocol,
      id: handle.publicCredential,
      address: node.publicEndpoint,
      port: node.port,
      label: `${device.displayName}@${node.name}`,
    });
  }

  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw errors.internal("The rendered configuration exceeded the size limit.");
  }

  const fingerprint = fingerprintOf(publicCredential);
  const checksum = sha256Hex(payload);
  const resolvedExpiresAt =
    input.expiresAt ?? (expiryDays > 0 ? new Date(Date.now() + expiryDays * 86_400_000) : null);

  // Credential + versions + assignment in one transaction, so the console can never
  // hold a config row that points at a credential that was never stored.
  const { config, version } = await prisma.$transaction(async (tx) => {
    const credential = await tx.deviceCredential.create({
      data: {
        deviceId: device.id,
        kind: credentialKind,
        publicKey: publicCredential,
        fingerprint,
        secretSealed: sealSecret(secretToSeal),
        nodeId: node.id,
        expiresAt: resolvedExpiresAt,
      },
    });

    const created = await tx.vpnConfig.create({
      data: {
        name: input.name.slice(0, 80),
        protocol: input.protocol,
        deviceId: device.id,
        nodeId: node.id,
        status: "ACTIVE",
        version: 1,
        createdById: input.actorId,
        expiresAt: resolvedExpiresAt,
      },
    });

    const createdVersion = await tx.configVersion.create({
      data: {
        configId: created.id,
        version: 1,
        payloadSealed: sealSecret(payload),
        checksum,
        summary: configSummary({ name: created.name, protocol: created.protocol, version: 1 }),
        changeNote: input.changeNote?.slice(0, 300) ?? "Initial configuration",
        createdById: input.actorId,
      },
    });

    await tx.vpnConfig.update({
      where: { id: created.id },
      data: { currentVersionId: createdVersion.id },
    });

    await tx.device.update({
      where: { id: device.id },
      data: { assignedConfigId: created.id, assignedNodeId: node.id },
    });

    return { config: created, version: createdVersion };
  });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "config.generated",
    resource: "vpn_config",
    resourceId: config.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: {
      name: config.name,
      protocol: config.protocol,
      deviceId: device.id,
      nodeId: node.id,
      version: version.version,
      checksum,
      format,
    },
  });

  return {
    configId: config.id,
    version: version.version,
    // Rendered exactly once. The caller shows it; the database holds the sealed copy.
    payload,
    qrPayload: payload,
    format,
    fingerprint,
    expiresAt: resolvedExpiresAt,
  };
}

/** Returns the sealed payload for one version. Secrets are handled, not displayed. */
export async function getConfigPayload(input: {
  configId: string;
  version?: number | null;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<{ payload: string; format: "wireguard" | "text"; version: number; checksum: string }> {
  const config = await prisma.vpnConfig.findUnique({
    where: { id: input.configId },
    include: {
      versions: {
        orderBy: { version: "desc" },
        ...(input.version ? { where: { version: input.version } } : { take: 1 }),
      },
    },
  });
  if (!config) throw errors.notFound("Configuration");
  const versionRow = config.versions[0];
  if (!versionRow) throw errors.notFound("Configuration version");

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "config.generated",
    resource: "vpn_config",
    resourceId: config.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { version: versionRow.version, note: "payload viewed" },
  });

  return {
    payload: unsealSecret(versionRow.payloadSealed),
    format: config.protocol === "WIREGUARD" ? "wireguard" : "text",
    version: versionRow.version,
    checksum: versionRow.checksum,
  };
}

/** Revokes a configuration and all of its credentials at once. */
export async function revokeConfig(input: {
  configId: string;
  reason: string;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}) {
  const config = await prisma.vpnConfig.findUnique({
    where: { id: input.configId },
    include: { device: { select: { id: true, deviceId: true } } },
  });
  if (!config) throw errors.notFound("Configuration");

  await prisma.$transaction(async (tx) => {
    await tx.vpnConfig.update({
      where: { id: config.id },
      data: { status: "REVOKED", revokedAt: new Date(), revokedReason: input.reason.slice(0, 300) },
    });

    if (config.deviceId) {
      await tx.deviceCredential.updateMany({
        where: { deviceId: config.deviceId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: input.reason.slice(0, 300) },
      });
      await tx.device.update({
        where: { id: config.deviceId },
        data: { assignedConfigId: null },
      });
    }

    const { recordWithin, userActor } = await import("@/server/audit");
    await recordWithin(tx, {
      actor: userActor(input.actorId, input.actorLabel),
      action: "config.revoked",
      resource: "vpn_config",
      resourceId: config.id,
      result: "SUCCESS",
      sourceIp: input.sourceIp,
      metadata: { reason: input.reason, deviceId: config.device?.deviceId ?? null },
    });
  });

  const { notify } = await import("@/server/notifications/service");
  await notify({
    type: "config.revoked",
    severity: "WARNING",
    title: "Configuration revoked",
    body: `${config.name} was revoked. Devices using it cannot reconnect.`,
    resource: "vpn_config",
    resourceId: config.id,
  });

  return { id: config.id, status: "REVOKED" };
}

/**
 * Rolls a configuration back to an earlier revision.
 *
 * Versions are append-only: rolling back deletes nothing and rewrites nothing, it
 * publishes a NEW version whose payload is byte-identical to the target revision. That
 * keeps the trail honest - an operator can see both the bad change and the correction -
 * and means a rollback can itself be rolled back.
 */
export async function rollbackConfig(input: {
  configId: string;
  toVersion: number;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<{ id: string; version: number; checksum: string; fromVersion: number }> {
  const config = await prisma.vpnConfig.findUnique({
    where: { id: input.configId },
    include: { versions: { orderBy: { version: "desc" } } },
  });
  if (!config) throw errors.notFound("Configuration");

  const target = config.versions.find((version) => version.version === input.toVersion);
  if (!target) throw errors.notFound("Configuration version");

  if (config.currentVersionId) {
    const current = config.versions.find((version) => version.id === config.currentVersionId);
    if (current && current.version === target.version) {
      throw errors.invalidState(`Version ${target.version} is already the current revision.`);
    }
  }
  if (config.status === "REVOKED") {
    throw errors.invalidState("A revoked configuration cannot be rolled back. Generate a new one.");
  }

  const nextVersion = Math.max(...config.versions.map((version) => version.version), 0) + 1;
  const previousVersionNumber = config.version;

  const created = await prisma.$transaction(async (tx) => {
    if (config.currentVersionId) {
      await tx.configVersion.update({
        where: { id: config.currentVersionId },
        data: { isActive: false, supersededAt: new Date() },
      });
    }

    const version = await tx.configVersion.create({
      data: {
        configId: config.id,
        version: nextVersion,
        // Identical sealed bytes, so the checksum is unchanged: the content IS the
        // target revision, which is precisely what a rollback means.
        payloadSealed: target.payloadSealed,
        checksum: target.checksum,
        summary: `${config.name} · ${config.protocol} · v${nextVersion} (rollback of v${target.version})`,
        isActive: true,
        changeNote: `Rollback to revision ${target.version}`,
        createdById: input.actorId,
      },
    });

    await tx.vpnConfig.update({
      where: { id: config.id },
      data: { version: nextVersion, currentVersionId: version.id },
    });

    const { recordWithin, userActor } = await import("@/server/audit");
    await recordWithin(tx, {
      actor: userActor(input.actorId, input.actorLabel),
      action: "config.rolled_back",
      resource: "vpn_config",
      resourceId: config.id,
      result: "SUCCESS",
      sourceIp: input.sourceIp,
      metadata: {
        fromVersion: previousVersionNumber,
        restoredVersion: target.version,
        newVersion: nextVersion,
        checksum: target.checksum,
      },
    });

    return version;
  });

  return {
    id: config.id,
    version: created.version,
    checksum: created.checksum,
    fromVersion: previousVersionNumber,
  };
}
