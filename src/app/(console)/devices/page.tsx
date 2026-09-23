"use client";

import { useState } from "react";
import { formatBytes } from "@/lib/format/units";
import { Button, DataTable, EmptyState, Pagination, StatusPill } from "@/components/ui/primitives";
import {
  approvalTone,
  connectionTone,
  formatDateTime,
  maskIp,
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
  approve: (id, note) => `/api/devices/${id}?action=approve`,
  reject: (id, note) => `/api/devices/${id}?action=reject`,
  block: (id, _, reason) => `/api/devices/${id}?action=block`,
  disconnect: (id, _, reason) => `/api/devices/${id}?action=disconnect`,
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
  const mutation = useActionRunner();

  const list = useList<DeviceRow>("/api/devices", {
    approvalState: approvalState || undefined,
    connectionStatus: connectionStatus || undefined,
    search: search || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const selectedSet = new Set(selectedIds);

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
          New devices start as PENDING when PRIVATE MODE is on. Rejected devices get a generic
          response and no credentials.
        </p>
      </div>



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
                      <span className="data-value">{formatBytes(BigInt(row.totalBytes))}</span>
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
                        <Button onClick={() => setActing({ id: row.id, action: "approve" })}>Approve</Button>
                        <Button onClick={() => setActing({ id: row.id, action: "reject" })}>Reject</Button>
                        <Button variant="danger" onClick={() => setActing({ id: row.id, action: "block" })}>Block</Button>
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