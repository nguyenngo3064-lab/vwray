import "server-only";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { deriveHealth } from "@/server/nodes/service";
import { getSetting } from "@/server/settings/service";

/**
 * Smart node routing.
 *
 * The score is a weighted sum of NORMALISED, MEASURED inputs. Three rules make it safe
 * to show to an operator:
 *
 *   1. **A metric that was never measured is `available: false`, not 0.** A node whose
 *      agent reports no latency does not get a perfect latency score; it gets
 *      "Unavailable" and that weight is excluded from the denominator.
 *   2. **A score with no measurable inputs is `routeScore: null`.** There is no such thing
 *      as a score of 0 here either - 0 would claim "measured, worst possible".
 *   3. **AUTO only ever affects NEW session placement.** Nothing in this module (or
 *      anywhere else) reassigns or drops an active connection; that requires an explicit
 *      `routing.moveActiveSessions` setting which defaults to false and, even then, is
 *      only ever honoured by an operator-initiated move action.
 *
 * The weights are a setting, and the exact numbers used are returned with the score, so
 * the console can show its calculation instead of asking anyone to trust a magic number.
 */

export interface RoutingWeights {
  latency: number;
  jitter: number;
  packetLoss: number;
  load: number;
  stability: number;
  capacity: number;
}

export const ROUTING_WEIGHT_SUM = 100;

export const DEFAULT_ROUTING_WEIGHTS: RoutingWeights = {
  latency: 30,
  jitter: 10,
  packetLoss: 25,
  load: 20,
  stability: 10,
  capacity: 5,
};

export interface MetricScore {
  key: keyof RoutingWeights;
  label: string;
  /** Raw measured value in its own unit. Null when the platform cannot measure it. */
  value: number | null;
  unit: string;
  /** Weight this metric contributes when available. */
  weight: number;
  /** 0-100 normalised goodness, null when unavailable. */
  normalized: number | null;
  /** Weighted points contributed to the score, null when unavailable. */
  contribution: number | null;
  available: boolean;
  /** Populated only when unavailable: why, in the platform's own words. */
  unavailableReason: string | null;
  /** Where the number came from (sample id / heartbeat), for the WHY view. */
  source: string | null;
}

export interface NodeRoutingView {
  nodeId: string;
  id: string;
  name: string;
  health: ReturnType<typeof deriveHealth>;
  eligible: boolean;
  ineligibleReason: string | null;
  routeScore: number | null;
  /** Share of total weight that could actually be measured (0-1). Null if nothing could. */
  coverage: number | null;
  lowConfidence: boolean;
  metrics: MetricScore[];
  activeSessions: number;
  weight: number;
  poolEnabled: boolean;
  lastHeartbeatAt: string | null;
}

export interface RoutingState {
  mode: "AUTO" | "MANUAL";
  autoSelectionEnabled: boolean;
  autoMoveActiveSessions: boolean;
  weights: RoutingWeights;
  weightSum: number;
  nodes: NodeRoutingView[];
  recommendation: {
    nodeId: string | null;
    name: string | null;
    score: number | null;
    reason: string;
    /** Recommendation only. Existing sessions are never moved by this engine. */
    affectsExistingSessions: false;
  };
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

/** Map a "lower is better" measurement onto 0-100 goodness. */
function lowerIsBetter(value: number, idealZero: number, unusableAt: number): number {
  if (value <= idealZero) return 100;
  if (value >= unusableAt) return 0;
  return 100 * (1 - (value - idealZero) / (unusableAt - idealZero));
}

async function metricInputs(nodeId: string): Promise<{
  latencyMs: { value: number | null; source: string | null; reason: string | null };
  jitterMs: { value: number | null; source: string | null; reason: string | null };
  packetLossPct: { value: number | null; source: string | null; reason: string | null };
  loadPct: { value: number | null; source: string | null; reason: string | null };
  stabilityPct: { value: number | null; source: string | null; reason: string | null };
  capacityPct: { value: number | null; source: string | null; reason: string | null };
}> {
  const since = new Date(Date.now() - 24 * 3600 * 1000);

  const [samples, node, coverage] = await Promise.all([
    prisma.nodeHealthSample.findMany({
      where: { nodeId, sampledAt: { gte: since } },
      orderBy: { sampledAt: "desc" },
      take: 500,
      select: {
        id: true,
        sampledAt: true,
        cpuPercent: true,
        ramPercent: true,
        latencyMs: true,
        jitterMs: true,
        packetLossPct: true,
      },
    }),
    prisma.vpnNode.findUnique({
      where: { id: nodeId },
      select: { id: true, cpuPercent: true, ramPercent: true, activeSessions: true, maxSessions: true },
    }),
    prisma.nodeHealthSample.groupBy({
      by: ["nodeId"],
      where: { nodeId, sampledAt: { gte: since } },
      _count: { _all: true },
    }),
  ]);

  const noTelemetry = "No telemetry sample in the last 24 hours.";

  // Latency / jitter / loss: newest reported value, only from samples that carry one.
  const latencySample = samples.find((row) => row.latencyMs !== null);
  const jitterSample = samples.find((row) => row.jitterMs !== null);
  const lossSample = samples.find((row) => row.packetLossPct !== null);

  const cpu = samples.find((row) => row.cpuPercent !== null)?.cpuPercent ?? node?.cpuPercent ?? null;
  const ram = samples.find((row) => row.ramPercent !== null)?.ramPercent ?? node?.ramPercent ?? null;
  const load = cpu !== null && ram !== null ? (cpu + ram) / 2 : cpu ?? ram;
  const loadSource = samples.find((row) => row.cpuPercent !== null)
    ? `health sample ${samples.find((row) => row.cpuPercent !== null)?.id ?? ""}`
    : node?.cpuPercent !== null
      ? "node heartbeat"
      : null;

  const sampleCount = coverage[0]?._count._all ?? 0;
  // 4 samples/hour is the agent's nominal cadence; 96 expected samples in 24h.
  const stability = sampleCount > 0 ? clamp((sampleCount / 96) * 100) : null;

  const capacity =
    node?.maxSessions && node.maxSessions > 0
      ? clamp(((node.maxSessions - node.activeSessions) / node.maxSessions) * 100)
      : null;

  return {
    latencyMs: latencySample
      ? { value: latencySample.latencyMs, source: `health sample ${latencySample.id}`, reason: null }
      : { value: null, source: null, reason: "The agent has not reported latency in the last 24 hours." },
    jitterMs: jitterSample
      ? { value: jitterSample.jitterMs, source: `health sample ${jitterSample.id}`, reason: null }
      : {
          value: null,
          source: null,
          reason: "The agent does not report jitter in the last 24 hours.",
        },
    packetLossPct: lossSample
      ? { value: lossSample.packetLossPct, source: `health sample ${lossSample.id}`, reason: null }
      : { value: null, source: null, reason: "The agent does not report packet loss in the last 24 hours." },
    loadPct:
      load !== null
        ? { value: load, source: loadSource ?? "node heartbeat", reason: null }
        : { value: null, source: null, reason: "The agent has never reported CPU or memory load." },
    stabilityPct:
      stability !== null
        ? { value: stability, source: `${sampleCount} health sample(s) in 24h`, reason: null }
        : { value: null, source: null, reason: noTelemetry },
    capacityPct:
      capacity !== null
        ? { value: capacity, source: "node session counters", reason: null }
        : { value: null, source: null, reason: "The node declares no session capacity." },
  };
}

async function routingWeights(): Promise<RoutingWeights> {
  const stored = await getSetting<Partial<RoutingWeights>>("routing.weights").catch(() => null);
  if (!stored || typeof stored !== "object") return DEFAULT_ROUTING_WEIGHTS;
  return {
    latency: Number(stored.latency ?? DEFAULT_ROUTING_WEIGHTS.latency),
    jitter: Number(stored.jitter ?? DEFAULT_ROUTING_WEIGHTS.jitter),
    packetLoss: Number(stored.packetLoss ?? DEFAULT_ROUTING_WEIGHTS.packetLoss),
    load: Number(stored.load ?? DEFAULT_ROUTING_WEIGHTS.load),
    stability: Number(stored.stability ?? DEFAULT_ROUTING_WEIGHTS.stability),
    capacity: Number(stored.capacity ?? DEFAULT_ROUTING_WEIGHTS.capacity),
  };
}

export async function setRoutingWeights(input: {
  weights: Partial<RoutingWeights>;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<RoutingWeights> {
  const { updateSetting } = await import("@/server/settings/service");
  const next = { ...DEFAULT_ROUTING_WEIGHTS, ...input.weights };
  await updateSetting({
    key: "routing.weights",
    value: next,
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    sourceIp: input.sourceIp,
  });
  return next;
}

async function scoreNode(
  node: {
    id: string;
    nodeId: string;
    name: string;
    status: "REGISTERING" | "ONLINE" | "OFFLINE" | "DEGRADED" | "REVOKED";
    health: ReturnType<typeof deriveHealth>;
    activeSessions: number;
    weight: number;
    draining: boolean;
    maintenance: boolean;
    lastHeartbeatAt: Date | null;
    poolEnabled: boolean;
  },
  weights: RoutingWeights,
): Promise<NodeRoutingView> {
  const inputs = await metricInputs(node.id);

  const specs: Array<{
    key: keyof RoutingWeights;
    label: string;
    unit: string;
    input: { value: number | null; source: string | null; reason: string | null };
    normalize: (value: number) => number;
  }> = [
    { key: "latency", label: "Latency", unit: "ms", input: inputs.latencyMs, normalize: (v) => lowerIsBetter(v, 0, 150) },
    { key: "jitter", label: "Jitter", unit: "ms", input: inputs.jitterMs, normalize: (v) => lowerIsBetter(v, 0, 30) },
    { key: "packetLoss", label: "Packet loss", unit: "%", input: inputs.packetLossPct, normalize: (v) => lowerIsBetter(v, 0, 5) },
    { key: "load", label: "CPU/RAM load", unit: "%", input: inputs.loadPct, normalize: (v) => clamp(100 - v) },
    { key: "stability", label: "Historical stability", unit: "%", input: inputs.stabilityPct, normalize: (v) => clamp(v) },
    { key: "capacity", label: "Session headroom", unit: "%", input: inputs.capacityPct, normalize: (v) => clamp(v) },
  ];

  const metrics: MetricScore[] = specs.map((spec) => {
    const available = spec.input.value !== null && Number.isFinite(spec.input.value);
    const normalized = available ? spec.normalize(spec.input.value as number) : null;
    return {
      key: spec.key,
      label: spec.label,
      value: available ? (spec.input.value as number) : null,
      unit: spec.unit,
      weight: weights[spec.key],
      normalized,
      contribution: available && normalized !== null ? (weights[spec.key] * normalized) / ROUTING_WEIGHT_SUM : null,
      available,
      unavailableReason: available ? null : (spec.input.reason ?? "Not measured."),
      source: spec.input.source,
    };
  });

  const availableWeight = metrics.reduce((sum, metric) => (metric.available ? sum + metric.weight : sum), 0);
  const rawContribution = metrics.reduce((sum, metric) => sum + (metric.contribution ?? 0), 0);

  // Denominator is the weight that could actually be measured, so an unavailable metric
  // neither inflates nor deflates the result - it simply does not participate.
  const coverage = availableWeight > 0 ? availableWeight / ROUTING_WEIGHT_SUM : null;
  const routeScore =
    availableWeight > 0 ? Math.round((rawContribution / availableWeight) * ROUTING_WEIGHT_SUM * 10) / 10 : null;

  let eligible = true;
  let ineligibleReason: string | null = null;
  if (node.status === "REVOKED") {
    eligible = false;
    ineligibleReason = "Node has been revoked.";
  } else if (node.status !== "ONLINE") {
    eligible = false;
    ineligibleReason = `Node is ${node.status}.`;
  } else if (node.health === "OFFLINE") {
    eligible = false;
    ineligibleReason = "Node is OFFLINE.";
  } else if (node.health === "UNKNOWN") {
    eligible = false;
    ineligibleReason = "No heartbeat has ever been received - health is unknown.";
  } else if (node.maintenance) {
    eligible = false;
    ineligibleReason = "Node is in MAINTENANCE.";
  } else if (node.draining) {
    eligible = false;
    ineligibleReason = "Node is DRAINING - no new sessions will be placed here.";
  } else if (!node.poolEnabled) {
    eligible = false;
    ineligibleReason = "Node is excluded from automatic placement (pool policy disabled).";
  } else if (routeScore === null) {
    eligible = false;
    ineligibleReason = "No metric could be measured, so no score exists for this node.";
  }

  return {
    nodeId: node.nodeId,
    id: node.id,
    name: node.name,
    health: node.health,
    eligible,
    ineligibleReason,
    routeScore,
    coverage,
    // Below half the weight measurable, a number is shown but flagged as low confidence.
    lowConfidence: coverage !== null && coverage < 0.5,
    metrics,
    activeSessions: node.activeSessions,
    weight: node.weight,
    poolEnabled: node.poolEnabled,
    lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null,
  };
}

/** Full routing picture for the console. */
export async function getRoutingState(): Promise<RoutingState> {
  const [autoEnabled, moveActive, weights, staleSeconds, nodes, pools] = await Promise.all([
    getSetting<boolean>("nodes.autoSelectionEnabled"),
    getSetting<boolean>("routing.moveActiveSessions").catch(() => false),
    routingWeights(),
    getSetting<number>("nodes.heartbeatStaleSeconds"),
    prisma.vpnNode.findMany({ orderBy: { name: "asc" } }),
    prisma.nodePoolPolicy.findMany(),
  ]);

  const poolByNode = new Map(pools.map((pool) => [pool.nodeId, pool]));

  const scored: NodeRoutingView[] = [];
  for (const node of nodes) {
    scored.push(
      await scoreNode(
        {
          id: node.id,
          nodeId: node.nodeId,
          name: node.name,
          status: node.status,
          health: deriveHealth({
            lastHeartbeatAt: node.lastHeartbeatAt,
            staleSeconds,
            maintenance: node.maintenance,
            draining: node.draining,
          }),
          activeSessions: node.activeSessions,
          weight: node.weight,
          draining: node.draining,
          maintenance: node.maintenance,
          lastHeartbeatAt: node.lastHeartbeatAt,
          poolEnabled: poolByNode.get(node.id)?.enabled ?? true,
        },
        weights,
      ),
    );
  }

  const candidates = scored
    .filter((node) => node.eligible && node.routeScore !== null)
    .sort((left, right) => (right.routeScore ?? -1) - (left.routeScore ?? -1));

  const best = candidates[0];
  const recommendation: RoutingState["recommendation"] = {
    nodeId: null,
    name: null,
    score: null,
    affectsExistingSessions: false,
    reason: autoEnabled
      ? candidates.length === 0
        ? "No eligible node has a measurable score, so no recommendation is offered."
        : `${best?.name ?? ""} scores highest (${best?.routeScore ?? "-"} of 100) on the configured weights.`
      : "Automatic selection is disabled (MANUAL mode): recommendations are not issued.",
  };
  if (autoEnabled && best) {
    recommendation.nodeId = best.id;
    recommendation.name = best.name;
    recommendation.score = best.routeScore;
  }

  return {
    mode: autoEnabled ? "AUTO" : "MANUAL",
    autoSelectionEnabled: autoEnabled,
    autoMoveActiveSessions: moveActive,
    weights,
    weightSum: Object.values(weights).reduce((sum, value) => sum + value, 0),
    nodes: scored,
    recommendation,
  };
}

/**
 * Node selection for a NEW session. Returns null (with a reason) rather than guessing.
 * Existing sessions are out of scope here by design - see the module comment.
 */
export async function selectNodeForNewSession(options?: {
  protocol?: string;
  excludeNodeIds?: string[];
}): Promise<{ nodeId: string | null; reason: string; score: number | null }> {
  const state = await getRoutingState();
  if (!state.autoSelectionEnabled) {
    return { nodeId: null, reason: "Routing is MANUAL: the operator assigns nodes.", score: null };
  }
  const excluded = new Set(options?.excludeNodeIds ?? []);
  const candidates = state.nodes
    .filter((node) => node.eligible && node.routeScore !== null && !excluded.has(node.id))
    .sort((left, right) => (right.routeScore ?? -1) - (left.routeScore ?? -1));

  if (candidates.length === 0) {
    return {
      nodeId: null,
      reason: "No eligible node has enough measured telemetry to be scored.",
      score: null,
    };
  }

  const best = candidates[0];
  return {
    nodeId: best.id,
    reason: `Highest routing score (${best.routeScore}) among ${candidates.length} eligible node(s); coverage ${Math.round((best.coverage ?? 0) * 100)}%.`,
    score: best.routeScore,
  };
}

export async function requireRoutingAdmin(actor: { role: string }): Promise<void> {
  if (actor.role !== "OWNER" && actor.role !== "ADMIN") {
    throw errors.forbidden("Changing routing weights requires an administrator.");
  }
}
