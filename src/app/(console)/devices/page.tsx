"use client";

import { useState } from "react";
import { formatBytes } from "@/lib/format/units";
import { Button, DataTable, EmptyState, Pagination, StatusPill, Input, Panel } from "@/components/ui/primitives";
import {
  approvalTone,
  connectionTone,
  formatDateTime,
  maskIp,
  readDeviceCounts,
  type DeviceRow,
} from "../_shared/ops-contract";
import {
  ActionModal,
  ActionField,
  useList,
  useActionRunner,
  AsyncPanel,
  FilterBar,
} from "../_shared/ops-view";

const PAGE_SIZE = 25;

type ActionKind = "approve" | "reject" | "block" | "disconnect";

const actionPaths: Record<ActionKind, (id: string, note: string, reason: string) => string> = {
  approve: (id, _note) => `/api/devices/${id}?action=approve`,
  reject: (id, _note) => `/api/devices/${id}?action=reject`,
  block: (id, _note, _reason) => `/api/devices/${id}?action=block`,
  disconnect: (id, _note, _reason) => `/api/devices/${id}?action=disconnect`,
};

const actionBodies: Record<ActionKind, (note: string, reason: string) => Record<string, string>> = {
  approve: (note) => ({ note }),
  reject: (note) => ({ note }),
  block: (_, reason) => ({ reason }),
  disconnect: (_, reason) => ({ reason }),
};


export default function DevicesPage() {
  const [approvalState, setApprovalState] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [acting, setActing] = useState<{ id: string; action: ActionKind } | null>(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [registration, setRegistration] = useState({ displayName: "", client: "", platform: "" });
  const mutation = useActionRunner();

  const list = useList<DeviceRow>("/api/devices", {
    approvalState: approvalState || undefined,
    connectionStatus: connectionStatus || undefined,
    search: search || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const selectedSet = new Set(selectedIds);
  const counts = readDeviceCounts(list.rawMeta);

  function toggle(id: string) {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [...current, id],
    );
  }

  async function submitSingle() {
    if (!acting) return;
    const path = actionPaths[acting.action](acting.id, note, reason);
    const body = actionBodies[acting.action](note, reason);
    const outcome = await mutation.run(path, {
      body,
      successNote: `Device ${acting.action}d.`,
      onDone: () => {
        setActing(null);
        setNote("");
        setReason("");
        list.refresh();
      },
    });
    return outcome.ok;
  }

  async function submitBulk(action: ActionKind) {
    const outcome = await mutation.run("/api/devices/bulk", {
      body: { action, ids: selectedIds, note, reason },
      successNote: `Bulk ${action} submitted.`,
      onDone: () => {
        setSelectedIds([]);
        setNote("");
        setReason("");
        list.refresh();
      },
    });
    return outcome.ok;
  }

  async function register() {
    const outcome = await mutation.run("/api/devices", {
      body: registration,
      successNote: "Device registered and waiting for approval.",
      onDone: () => {
        setRegistration({ displayName: "", client: "", platform: "" });
        list.refresh();
      },
    });
    return outcome.ok;
  }

  const singleFields: ActionField[] = acting
    ? acting.action === "approve" || acting.action === "reject"
      ? [{ id: "note", label: "Operator note", kind: "textarea", value: note, onChange: setNote }]
      : [{ id: "reason", label: "Reason", kind: "textarea", value: reason, onChange: setReason, required: true }]
    : [];

  const singleReady =
    !acting
      ? true
      : acting.action === "block" || acting.action === "disconnect"
      ? reason.trim().length > 0
      : true;

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Devices</h1>
        <p className="text-[12.5px] text-muted">
          Monitor active connections, mobile data usage, and access decisions from one place.
        </p>
      </div>

      <Panel title="Register device" bodyClassName="space-y-3 p-4">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
          <label className="space-y-1">
            <span className="micro-label block">Display name</span>
            <Input value={registration.displayName} onChange={(event) => setRegistration({ ...registration, displayName: event.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="micro-label block">Client</span>
            <Input value={registration.client} onChange={(event) => setRegistration({ ...registration, client: event.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="micro-label block">Platform</span>
            <Input value={registration.platform} onChange={(event) => setRegistration({ ...registration, platform: event.target.value })} />
          </label>
          <Button variant="primary" onClick={() => void register()} disabled={mutation.busy || !registration.displayName.trim() || !registration.client.trim() || !registration.platform.trim()}>
            {mutation.busy ? "Registering..." : "Register"}
          </Button>
        </div>
        {mutation.error ? <p className="text-[12px] text-danger" role="alert">{mutation.error}</p> : null}
      </Panel>

      {counts ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
          {[
            ["Total devices", counts.total, ""],
            ["Approved slots", `${counts.approved}/${counts.maxApproved}`, ""],
            ["Online now", counts.online, "ONLINE"],
            ["Waiting approval", counts.pending, "PENDING"],
            ["Blocked", counts.blocked, "BLOCKED"],
            ["Quota exceeded", counts.quotaExceeded, "QUOTA_EXCEEDED"],
          ].map(([label, value, filter]) => (
            <button
              key={label}
              type="button"
              className="panel p-3 text-left transition-colors hover:border-border-strong"
              onClick={() => {
                setConnectionStatus(filter === "ONLINE" || filter === "QUOTA_EXCEEDED" ? filter : "");
                setApprovalState(filter === "PENDING" || filter === "BLOCKED" ? filter : "");
                setPage(1);
              }}
            >
              <span className="micro-label block">{label}</span>
              <span className="mt-1 block font-mono text-xl text-primary">{value}</span>
            </button>
          ))}
        </div>
      ) : null}


      <AsyncPanel
        loading={list.loading}
        error={list.error}
        subject="devices"
        label="Loading devices"
        onRetry={list.refresh}
      >
        {!list.items || list.items.length === 0 ? (
          <EmptyState
            title="No devices"
            message="No devices match the current filters. Devices appear here after they register."
          />
        ) : (
          <>
            <FilterBar
              filters={[
                {
                  id: "approvalState",
                  label: "Approval",
                  value: approvalState,
                  onChange: (value: string) => { setApprovalState(value); setPage(1); },
                  options: [
                    { id: "", label: "All" },
                    { id: "PENDING", label: "Pending" },
                    { id: "APPROVED", label: "Approved" },
                    { id: "REJECTED", label: "Rejected" },
                    { id: "BLOCKED", label: "Blocked" },
                  ]
                },
                {
                  id: "connectionStatus",
                  label: "Connection",
                  value: connectionStatus,
                  onChange: (value: string) => { setConnectionStatus(value); setPage(1); },
                  options: [
                    { id: "", label: "All" },
                    { id: "ONLINE", label: "Online" },
                    { id: "OFFLINE", label: "Offline" },
                    { id: "CONNECTING", label: "Connecting" },
                    { id: "QUOTA_EXCEEDED", label: "Quota exceeded" },
                    { id: "REVOKED", label: "Revoked" },
                  ]
                },
              ]}
              search={{
                value: search,
                placeholder: "Search name, id or client",
                onChange: (value: string) => { setSearch(value); setPage(1); },
              }}
            />

            {selectedIds.length > 0 ? (
              <div className="panel flex flex-wrap items-center gap-2 p-3">
                <span className="text-[12px] text-muted">{selectedIds.length} selected</span>
                <Button onClick={() => void submitBulk("approve")} disabled={mutation.busy}>Approve</Button>
                <Button onClick={() => void submitBulk("reject")} disabled={mutation.busy}>Reject</Button>
                <Button variant="danger" onClick={() => void submitBulk("block")} disabled={mutation.busy}>Block</Button>
                <Button onClick={() => void submitBulk("disconnect")} disabled={mutation.busy}>Disconnect</Button>
                <Button onClick={() => setSelectedIds([])}>Clear</Button>
                {mutation.error ? (
                  <span className="text-[12px] text-danger" role="alert">{mutation.error}</span>
                ) : null}
              </div>
            ) : null}

            <div className="panel">
              <DataTable<DeviceRow>
                caption="Devices"
                columns={[
                  {
                    key: "check",
                    header: "",
                    align: "left" as const,
                    render: (row) => (
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.displayName} ${row.deviceId}`}
                        checked={selectedSet.has(row.id)}
                        onChange={() => toggle(row.id)}
                      />
                    ),
                  },
                  {
                    key: "device",
                    header: "Device",
                    render: (row) => (
                      <div>
                        <div className="font-medium text-primary">{row.displayName}</div>
                        <div className="font-mono text-[11px] text-faint">{row.deviceId}</div>
                      </div>
                    ),
                  },
                  {
                    key: "approval",
                    header: "Approval",
                    render: (row) => (
                      <StatusPill tone={approvalTone(row.approvalState)}>{row.approvalState}</StatusPill>
                    ),
                  },
                  {
                    key: "connection",
                    header: "Connection",
                    render: (row) => (
                      <StatusPill tone={connectionTone(row.connectionStatus)}>{row.connectionStatus}</StatusPill>
                    ),
                  },
                  {
                    key: "traffic",
                    header: "Traffic",
                    align: "right" as const,
                    render: (row) => (
                      <div className="space-y-0.5 text-right">
                        <div className="data-value">{formatBytes(BigInt(row.totalBytes))}</div>
                        <div className="text-[10px] text-faint">
                          ↑ {formatBytes(BigInt(row.uploadBytes))} · ↓ {formatBytes(BigInt(row.downloadBytes))}
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: "seen",
                    header: "Last seen",
                    render: (row) => (
                      <span className="text-muted">{formatDateTime(row.lastSeenAt)}</span>
                    ),
                  },
                  {
                    key: "ip",
                    header: "Source IP",
                    render: (row) => (
                      <span className="font-mono text-[12px]">{maskIp(row.publicSourceIp)}</span>
                    ),
                  },
                  {
                    key: "actions",
                    header: "Actions",
                    align: "right" as const,
                    render: (row) => (
                      <span className="flex justify-end gap-1.5">
                        {row.approvalState === "PENDING" ? (
                          <Button onClick={() => setActing({ id: row.id, action: "approve" })}>Approve</Button>
                        ) : null}
                        {row.connectionStatus === "ONLINE" ? (
                          <Button onClick={() => setActing({ id: row.id, action: "disconnect" })}>Disconnect</Button>
                        ) : null}
                        {row.approvalState !== "BLOCKED" ? (
                          <Button variant="danger" onClick={() => setActing({ id: row.id, action: "block" })}>Block</Button>
                        ) : null}
                      </span>
                    ),
                  },
                ]}
                rows={list.items}
                keyOf={(row) => row.id}
              />
              <div className="p-3">
                <Pagination
                  page={page}
                  pageSize={PAGE_SIZE}
                  total={list.meta.total}
                  onPage={setPage}
                />
              </div>
            </div>
          </>
        )}
      </AsyncPanel>

      <ActionModal
        open={acting !== null}
        title={acting ? acting.action + " device" : ""}
        description="The device sees only a generic message. The reason stays in the audit log."
        fields={singleFields}
        submitLabel={acting ? acting.action : "Submit"}
        danger={acting?.action === "block"}
        ready={singleReady}
        busy={mutation.busy}
        error={mutation.error}
        onClose={() => { setActing(null); mutation.clear(); }}
        onSubmit={() => void submitSingle()}
      />
    </div>
  );
}