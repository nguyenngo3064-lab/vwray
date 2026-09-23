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
