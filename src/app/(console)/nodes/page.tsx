"use client";

import { useState } from "react";
import { Button, DataTable, EmptyState, Pagination, StatusPill, Select, Input, Panel, type TableColumn } from "@/components/ui/primitives";
import {
  formatDateTime,
  formatRelative,
  healthTone,
  protocolTone,
  nodeHealthReason,
  type NodeRow,
} from "../_shared/ops-contract";
import {
  AsyncPanel,
  FilterBar,
  useList,
  useActionRunner,
  ActionModal,
  ActionField,
} from "../_shared/ops-view";

const PAGE_SIZE = 25;

const NODES_BASE = "/api/nodes";

export default function NodesPage() {
  const [search, setSearch] = useState("");
  const [protocol, setProtocol] = useState("");
  const [health, setHealth] = useState("");
  const [page, setPage] = useState(1);
  const [acting, setActing] = useState<{ id: string; action: "rotateToken" | "remove"; note?: string } | null>(null);
  const [reason, setReason] = useState("");
  const [registration, setRegistration] = useState({ name: "", location: "", publicEndpoint: "", port: "51820", protocol: "WIREGUARD" });
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const mutation = useActionRunner();
  const columns = nodeColumns((action, id) => setActing({ id, action }));

  const list = useList<NodeRow>(NODES_BASE, {
    search: search || undefined,
    protocol: protocol || undefined,
    health: health || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const totalNodes = list.meta.total;
  const onlineCount = list.items?.filter((n) => n.health === "ONLINE").length ?? 0;

  async function submit() {
    if (!acting) return false;
    const id = acting.id;
    let outcome: Awaited<ReturnType<typeof mutation.run>>;
    if (acting.action === "rotateToken") {
      outcome = await mutation.run(`${NODES_BASE}/${id}/token`, {
        method: "POST",
        body: { reason },
        successNote: "Node token rotated.",
        onDone: () => { setActing(null); setReason(""); list.refresh(); },
      });
    } else {
      outcome = await mutation.run(`${NODES_BASE}/${id}`, {
        method: "DELETE",
        body: { reason },
        successNote: "Node permanently removed.",
        onDone: () => { setActing(null); setReason(""); list.refresh(); },
      });
    }
    return outcome.ok;
  }

  async function register() {
    const outcome = await mutation.run<{ agentToken: string }>(NODES_BASE, {
      body: {
        ...registration,
        port: Number(registration.port),
        isRealGateway: true,
      },
      successNote: "Node registered. Store the agent token and configure the node heartbeat.",
      onDone: () => {
        setRegistration({ name: "", location: "", publicEndpoint: "", port: "51820", protocol: "WIREGUARD" });
        list.refresh();
      },
    });
    if (outcome.ok) setIssuedToken(outcome.data.agentToken);
    return outcome.ok;
  }

  const singleFields: ActionField[] = acting
    ? [{ id: "reason", label: "Reason", kind: "textarea", value: reason, onChange: setReason, required: acting.action === "remove" }]
    : [];

  const ready = !acting || (acting.action === "remove" ? reason.trim().length > 0 : true);

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-baseline gap-3">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-semibold text-primary">VPN nodes</h1>
          <div className="text-[11px] text-muted">
            {totalNodes} node{totalNodes !== 1 ? "s" : ""} · {onlineCount} online
          </div>
        </div>
        <div className="flex flex-1 flex-wrap items-center gap-2 justify-end">
          <Select
            value={protocol}
            onChange={(e) => { setProtocol(e.target.value); setPage(1); }}
            aria-label="Filter by protocol"
          >
            <option value="">All protocols</option>
            <option value="WIREGUARD">WireGuard</option>
            <option value="XRAY_VLESS">Xray VLESS</option>
            <option value="XRAY_VMESS">Xray VMess</option>
            <option value="XRAY_TROJAN">Xray Trojan</option>
            <option value="MOCK">Mock (dev only)</option>
          </Select>
          <Select
            value={health}
            onChange={(e) => { setHealth(e.target.value); setPage(1); }}
            aria-label="Filter by health"
          >
            <option value="">All health</option>
            <option value="ONLINE">Online</option>
            <option value="DEGRADED">Degraded</option>
            <option value="OFFLINE">Offline</option>
            <option value="UNKNOWN">Unknown</option>
          </Select>
        </div>
      </div>

      <Panel title="NPV Tunnel setup">
        <details className="group">
          <summary className="cursor-pointer text-[12.5px] font-medium text-primary">
            How to connect NPV Tunnel
          </summary>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-[12px] leading-relaxed text-muted">
            <li>Install NPV Tunnel and create a new tunnel profile.</li>
            <li>Choose a node with <span className="font-mono text-primary">ONLINE</span> health in the table below.</li>
            <li>Use that node&apos;s <span className="font-mono text-primary">Endpoint</span> as the server address and its port.</li>
            <li>Select the same protocol shown in the node row. Do not mix WireGuard and Xray fields.</li>
            <li>Enter the client credential from the node profile, then save and connect.</li>
            <li>Open Devices to approve a new connection, disconnect it, or block it.</li>
          </ol>
          <p className="mt-3 border-t border-border pt-3 text-[11.5px] leading-relaxed text-faint">
            Private keys, passwords, and node tokens are never displayed here. Ask the node operator for the matching client profile through a secure channel.
          </p>
        </details>
      </Panel>

      <Panel title="Register VPN node" bodyClassName="space-y-3 p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_8rem_10rem_auto] md:items-end">
          <label className="space-y-1"><span className="micro-label block">Name</span><Input value={registration.name} onChange={(event) => setRegistration({ ...registration, name: event.target.value })} /></label>
          <label className="space-y-1"><span className="micro-label block">Location</span><Input value={registration.location} onChange={(event) => setRegistration({ ...registration, location: event.target.value })} /></label>
          <label className="space-y-1"><span className="micro-label block">Public endpoint</span><Input value={registration.publicEndpoint} onChange={(event) => setRegistration({ ...registration, publicEndpoint: event.target.value })} /></label>
          <label className="space-y-1"><span className="micro-label block">Port</span><Input type="number" value={registration.port} onChange={(event) => setRegistration({ ...registration, port: event.target.value })} /></label>
          <label className="space-y-1"><span className="micro-label block">Protocol</span><Select value={registration.protocol} onChange={(event) => setRegistration({ ...registration, protocol: event.target.value })}><option value="WIREGUARD">WireGuard</option><option value="XRAY_VLESS">Xray VLESS</option><option value="XRAY_VMESS">Xray VMess</option><option value="XRAY_TROJAN">Xray Trojan</option></Select></label>
          <Button variant="primary" onClick={() => void register()} disabled={mutation.busy || !registration.name.trim() || !registration.location.trim() || !registration.publicEndpoint.trim()}>Register</Button>
        </div>
        {issuedToken ? <div className="border-t border-border pt-3 text-[12px]" role="status"><p className="text-warning">Copy this token now. It is shown once.</p><code className="mt-1 block break-all font-mono text-primary">{issuedToken}</code></div> : null}
        {mutation.error ? <p className="text-[12px] text-danger" role="alert">{mutation.error}</p> : null}
      </Panel>

      <FilterBar
        filters={[]}
        search={{ value: search, placeholder: "Search nodes…", onChange: setSearch }}
      />

      <AsyncPanel
        loading={list.loading}
        error={list.error}
        subject="nodes"
        onRetry={list.refresh}
        rows={14}
        label={`${totalNodes} node${totalNodes !== 1 ? "s" : ""}`}
      >
        {(!list.items || list.items.length === 0) ? (
          <EmptyState
            title="No VPN nodes"
            message="No nodes have been registered yet. Add a node to begin routing traffic through it."
          />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={list.items}
              keyOf={(row) => row.id}
            />
            <div className="p-3">
              <Pagination page={page} pageSize={PAGE_SIZE} total={totalNodes} onPage={setPage} />
            </div>
          </>
        )}
      </AsyncPanel>

      <ActionModal
        open={acting !== null}
        title={acting ? (acting.action === "rotateToken" ? "Rotate node token" : "Remove node") : ""}
        description={acting?.action === "remove"
          ? "The node is permanently removed. Connected devices lose access once the agent acknowledges the removal."
          : "A new agent token is issued. Distribute it to the node operator out of band. The previous token stops working on the next heartbeat."}
        fields={singleFields}
        submitLabel={acting?.action === "rotateToken" ? "Rotate token" : "Remove node"}
        danger={acting?.action === "remove"}
        ready={ready}
        busy={mutation.busy}
        error={mutation.error}
        onClose={() => { setActing(null); setReason(""); mutation.clear(); }}
        onSubmit={() => void submit()}
      />
    </div>
  );
}

/**
 * Table columns. The action column receives a callback instead of closing over the
 * page's state setter, so the array can stay module-level (no re-creation per render).
 */
function nodeColumns(onAct: (action: "rotateToken" | "remove", id: string) => void): TableColumn<NodeRow>[] {
  return [
  {
    key: "name",
    header: "Name",
    render: (row: NodeRow) => (
      <div>
        <div className="font-medium text-primary">{row.name}</div>
        <div className="font-mono text-[11px] text-faint">{row.nodeId}</div>
      </div>
    ),
  },
  {
    key: "location",
    header: "Location",
    render: (row: NodeRow) => (
      <span className="text-muted">{row.location || <span className="text-faint">—</span>}</span>
    ),
  },
  {
    key: "endpoint",
    header: "Endpoint",
    render: (row: NodeRow) => (
      <span className="font-mono text-[12px]">{row.publicEndpoint}:{row.port}</span>
    ),
  },
  {
    key: "protocol",
    header: "Protocol",
    render: (row: NodeRow) => (
      <StatusPill tone={protocolTone(row.protocol)}>{row.protocol}</StatusPill>
    ),
  },
  {
    key: "health",
    header: "Health",
    render: (row: NodeRow) => (
      <div className="inline-flex flex-col gap-0.5">
        <StatusPill tone={healthTone(row.health)}>{row.health}</StatusPill>
        {row.healthReason && (
          <span className="text-[11px] text-muted leading-snug">{row.healthReason}</span>
        )}
      </div>
    ),
  },
  {
    key: "sessions",
    header: "Sessions",
    align: "right" as const,
    render: (row: NodeRow) => (
      <span className="text-muted">
        {row.activeSessions} / {row.maxSessions ?? <span className="text-faint">—</span>}
      </span>
    ),
  },
  {
    key: "tokenHint",
    header: "Token",
    render: (row: NodeRow) => (
      <span className="font-mono text-[11px] text-faint truncate max-w-[140px] inline-block" title={row.tokenHint ?? ""}>
        {row.tokenHint ?? <span className="italic">not issued</span>}
      </span>
    ),
  },
  {
    key: "updatedAt",
    header: "Updated",
    render: (row: NodeRow) => (
      <span className="text-muted">{formatDateTime(row.updatedAt)}</span>
    ),
  },
  {
    key: "actions",
    header: "Actions",
    align: "right" as const,
    render: (row: NodeRow) => (
      <span className="flex justify-end gap-1.5">
        <Button size="sm" onClick={() => onAct("rotateToken", row.id)}>
          Rotate token
        </Button>
        <Button size="sm" variant="danger" onClick={() => onAct("remove", row.id)}>
          Remove
        </Button>
      </span>
    ),
  },
  ];
}
