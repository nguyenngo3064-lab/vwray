"use client";

import { useEffect, useState } from "react";
import { Callout, EmptyState, ErrorState, KeyValue, LoadingState, Panel, Stat, StatusPill } from "@/components/ui/primitives";
import { apiFetch } from "@/lib/api/client";
import { formatBytes } from "@/lib/format/units";

/**
 * Overview — the console landing page.
 *
 * Everything here comes from `/api/overview`, one coherent server-side instant.
 * Sections with no data render "Unavailable"/empty rather than a plausible lie.
 */

interface OverviewPayload {
  system: {
    controlPlane: string;
    gateway: { state: string; nodesOnline: number; nodesTotal: number; mockOnly: boolean };
  };
  network: {
    devicesTotal: number;
    devicesOnline: number;
    devicesPending: number;
    devicesBlocked: number;
    devicesQuotaExceeded: number;
  };
  data: { usedTodayBytes: string; usedMonthBytes: string; estimatedCostMonth: number | null; currency: string };
  quota: { exceededCount: number };
  recentNodes: Array<{
    id: string;
    name: string;
    health: string;
    activeSessions: number;
    lastHeartbeatAt: number | null;
  }>;
  alerts: { openAnomalies: number; unreadNotifications: number };
  mockDataPresent: boolean;
}

function toneForHealth(health: string): "success" | "warning" | "danger" | "neutral" {
  if (health === "ONLINE") return "success";
  if (health === "DEGRADED" || health === "DRAINING" || health === "MAINTENANCE") return "warning";
  if (health === "OFFLINE") return "danger";
  return "neutral";
}

export default function OverviewPage() {
  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<OverviewPayload>("/api/overview", { signal: controller.signal })
      .then(setOverview)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "Unable to load the overview.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
        <p className="text-[12.5px] text-muted">
          Fleet state, traffic and alerts as of one server-side instant. Empty sections mean no data, not zero usage.
        </p>
      </div>

      {loading ? <LoadingState label="Loading overview..." /> : null}
      {error ? <ErrorState title="Unable to load the overview" message={error} /> : null}
      {!loading && !error && !overview ? (
        <EmptyState title="No overview data" message="The control plane returned no overview payload." />
      ) : null}

      {overview ? (
        <>
          {overview.mockDataPresent ? (
            <Callout kind="warning" title="Mock samples present">
              Some metrics include MOCK samples from the development gateway. Real and mock data are never merged silently.
            </Callout>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Panel title="Devices" bodyClassName="p-4">
              <Stat label="Total" value={String(overview.network.devicesTotal)} />
              <KeyValue label="Online" value={String(overview.network.devicesOnline)} />
              <KeyValue label="Pending approval" value={String(overview.network.devicesPending)} />
              <KeyValue
                label="Blocked / quota"
                value={`${overview.network.devicesBlocked} / ${overview.network.devicesQuotaExceeded}`}
              />
            </Panel>
            <Panel title="VPN nodes" bodyClassName="p-4">
              <Stat
                label="Reporting"
                value={`${overview.system.gateway.nodesOnline}/${overview.system.gateway.nodesTotal}`}
              />
              <KeyValue
                label="Gateway"
                value={
                  <StatusPill
                    tone={
                      overview.system.gateway.state === "connected"
                        ? "success"
                        : overview.system.gateway.state === "degraded"
                          ? "warning"
                          : "danger"
                    }
                    label={overview.system.gateway.state}
                  />
                }
              />
              {overview.system.gateway.mockOnly ? (
                <KeyValue label="Note" value="All nodes are development mocks." />
              ) : null}
            </Panel>
            <Panel title="Data used" bodyClassName="p-4">
              <Stat label="Today" value={formatBytes(BigInt(overview.data.usedTodayBytes))} />
              <KeyValue label="This month" value={formatBytes(BigInt(overview.data.usedMonthBytes))} />
              <KeyValue
                label="Est. cost (month)"
                value={
                  overview.data.estimatedCostMonth === null
                    ? "Unavailable"
                    : `${overview.data.estimatedCostMonth.toLocaleString()} ${overview.data.currency}`
                }
              />
            </Panel>
          </div>

          <Panel title="Alerts" bodyClassName="p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <KeyValue label="Open anomalies" value={String(overview.alerts.openAnomalies)} />
              <KeyValue label="Unread notifications" value={String(overview.alerts.unreadNotifications)} />
            </div>
            {overview.quota.exceededCount > 0 ? (
              <p className="mt-2 text-[12px] text-warning">
                {overview.quota.exceededCount} device(s) currently exceed their quota.
              </p>
            ) : null}
          </Panel>

          <Panel title="Nodes" bodyClassName="p-0">
            {overview.recentNodes.length === 0 ? (
              <EmptyState
                title="No VPN nodes yet"
                message="Register a node from the Nodes page, or point a node agent at this control plane."
              />
            ) : (
              <ul className="divide-y divide-border">
                {overview.recentNodes.map((node) => (
                  <li key={node.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-[12.5px] font-medium text-primary">{node.name}</p>
                      <p className="text-[11px] text-muted">
                        {node.lastHeartbeatAt
                          ? `Last heartbeat ${new Date(node.lastHeartbeatAt).toLocaleString()}`
                          : "No heartbeat received yet"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11.5px] text-muted">{node.activeSessions} session(s)</span>
                      <StatusPill tone={toneForHealth(node.health)} label={node.health} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}

