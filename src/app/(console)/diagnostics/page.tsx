"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Callout,
  DataTable,
  EmptyState,
  ErrorState,
  KeyValue,
  LoadingState,
  Panel,
  StatusPill,
  type TableColumn,
} from "@/components/ui/primitives";
import { apiFetch } from "@/lib/api/client";

/**
 * Diagnostics — the deployment and network truth panel.
 *
 * Each address class is shown separately: control-plane URL, outbound IP,
 * inbound reachability, VPN node endpoints, tunnel addresses. The page never
 * collapses them into one "your IP is X" claim, and UNVERIFIED is displayed as
 * its own honest state.
 */

interface Snapshot {
  platform: { provider: string; isProduction: boolean; notes: string[] };
  controlPlane: {
    url: string;
    hostname: string;
    hostnameSource: string;
    isLoopback: boolean;
    port: number | null;
    portSource: string;
  };
  outboundIp: {
    status: "OK" | "UNKNOWN";
    address: string | null;
    family: string | null;
    provider: string | null;
    consistent: boolean | null;
    candidates: string[];
    checkedAt: string | null;
    previousAddress: string | null;
    changed: boolean | null;
    changedAt: string | null;
    reason: string | null;
  };
  inbound: {
    status: "UNVERIFIED";
    tcp: { note: string };
    udp: { status: "UNVERIFIED"; note: string };
  };
  vpnNodes: Array<{
    nodeId: string;
    name: string;
    publicEndpoint: string;
    port: number;
    protocol: string;
    approvalState: string;
    agentOnline: boolean;
    wireguardState: string;
    vpnReachable: "UNVERIFIED";
  }>;
  tunnel: { controlPlaneInterface: null; note: string };
  generatedAt: string;
}

const nodeColumns: Array<TableColumn<Snapshot["vpnNodes"][number]>> = [
  { key: "name", header: "Node", render: (row) => `${row.name} (${row.nodeId})` },
  {
    key: "endpoint",
    header: "Public endpoint",
    render: (row) => <span className="font-mono text-[11px]">{`${row.publicEndpoint}:${row.port}`}</span>,
  },
  { key: "agent", header: "Agent", render: (row) => <StatusPill tone={row.agentOnline ? "success" : "danger"} label={row.agentOnline ? "AGENT_ONLINE" : "AGENT_OFFLINE"} /> },
  { key: "wg", header: "WireGuard", render: (row) => <StatusPill tone={row.wireguardState === "READY" ? "success" : row.wireguardState === "DOWN" ? "danger" : "neutral"} label={`WIREGUARD_${row.wireguardState}`} /> },
  { key: "reachable", header: "Tunnel reachable", render: () => <StatusPill tone="neutral" label="VPN_UNVERIFIED" /> },
];

export default function DiagnosticsPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const payload = refresh
        ? await apiFetch<Snapshot>("/api/deployment/network/refresh", { method: "POST", body: {} })
        : await apiFetch<Snapshot>("/api/deployment/network");
      setSnapshot(payload);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Unable to load diagnostics.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Diagnostics</h1>
          <p className="text-[12.5px] text-muted">
            Where this control plane lives, what it can reach, and what clients must use to connect.
          </p>
        </div>
        <Button variant="primary" onClick={() => void load(true)} disabled={refreshing}>
          {refreshing ? "Refreshing..." : "Refresh now"}
        </Button>
      </div>

      {loading ? <LoadingState label="Detecting deployment network..." /> : null}
      {error ? <ErrorState title="Unable to load diagnostics" message={error} /> : null}

      {snapshot ? (
        <>
          <Panel title="Control plane" bodyClassName="p-4">
            <KeyValue label="Public URL" value={snapshot.controlPlane.url || "Unresolved"} />
            <KeyValue label="Hostname source" value={snapshot.controlPlane.hostnameSource} />
            <KeyValue
              label="Container port"
              value={
                snapshot.controlPlane.port === null
                  ? "Not provided (no PORT)"
                  : `${snapshot.controlPlane.port} (from ${snapshot.controlPlane.portSource})`
              }
            />
            {snapshot.controlPlane.isLoopback ? (
              <p className="mt-1 text-[12px] text-warning">
                The hostname resolves to loopback: this instance is not reachable from the Internet.
              </p>
            ) : null}
          </Panel>

          <Panel title="Outbound IP (this container)" bodyClassName="p-4">
            {snapshot.outboundIp.status === "OK" && snapshot.outboundIp.address ? (
              <>
                <KeyValue
                  label="Address"
                  value={
                    <span className="font-mono">
                      {snapshot.outboundIp.address}
                      {snapshot.outboundIp.consistent === false ? " (providers disagree — see below)" : ""}
                    </span>
                  }
                />
                <KeyValue label="Detected via" value={snapshot.outboundIp.provider ?? "Unknown"} />
                <KeyValue label="Last checked" value={snapshot.outboundIp.checkedAt ?? "Unknown"} />
                {snapshot.outboundIp.changed
                  ? <KeyValue label="Changed" value={`yes, at ${snapshot.outboundIp.changedAt ?? "unknown time"}`} />
                  : null}
                {snapshot.outboundIp.reason ? (
                  <p className="mt-1 text-[12px] text-muted">{snapshot.outboundIp.reason}</p>
                ) : null}
              </>
            ) : (
              <Callout kind="warning" title="Outbound IP unknown">
                {snapshot.outboundIp.reason ?? "Detection failed. Retrying later is safe; nothing is assumed in the meantime."}
              </Callout>
            )}
          </Panel>

          <Callout kind="info" title="Outbound IP is not a VPN endpoint">
            The address above is what the open Internet sees when this container makes requests. It does not mean
            clients can reach a WireGuard tunnel here. Clients connect to a VPN node endpoint below — never to this address.
          </Callout>

          <Panel title="Inbound reachability" bodyClassName="p-4">
            <KeyValue
              label="Status"
              value={<StatusPill tone="neutral" label={snapshot.inbound.status} />}
            />
            <p className="text-[12px] text-muted">TCP: {snapshot.inbound.tcp.note}</p>
            <p className="text-[12px] text-muted">UDP: {snapshot.inbound.udp.note}</p>
          </Panel>

          <Panel title="Platform" bodyClassName="p-4">
            <KeyValue label="Provider" value={snapshot.platform.provider} />
            {snapshot.platform.notes.map((note) => (
              <p key={note.slice(0, 48)} className="text-[12px] text-muted">- {note}</p>
            ))}
          </Panel>

          <Panel title="VPN node endpoints" bodyClassName="p-0">
            {snapshot.vpnNodes.length === 0 ? (
              <EmptyState
                title="No VPN nodes"
                message="No node endpoints exist yet. Register one from the Nodes page; clients connect to a node's endpoint, never to the control plane."
              />
            ) : (
              <DataTable rows={snapshot.vpnNodes} columns={nodeColumns} keyOf={(row) => row.nodeId} />
            )}
          </Panel>

          <Panel title="Tunnel addresses" bodyClassName="p-4">
            <p className="text-[12px] text-muted">{snapshot.tunnel.note}</p>
          </Panel>
        </>
      ) : null}
    </div>
  );
}

