"use client";

import { useState } from "react";
import { Button, DataTable, EmptyState, Pagination, StatusPill, Select, Input, Panel, UsageBar, Callout } from "@/components/ui/primitives";
import { formatBytes, formatDateTime } from "@/lib/format/units";
import { quotaTone, type QuotaView } from "../_shared/ops-contract";
import { AsyncPanel, FilterBar, useList, useActionRunner, ActionModal, ActionField } from "../_shared/ops-view";
import { formatRelative } from "../_shared/ops-contract";

const PAGE_SIZE = 25;
const QUOTA_BASE = "/api/quota";

export default function QuotaPage() {
  const [scopeFilter, setScopeFilter] = useState("");
  const [exceededOnly, setExceededOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [acting, setActing] = useState<{ action: "reset"; id: string; note?: string } | null>(null);
  const [note, setNote] = useState("");
  const mutation = useActionRunner();

  const list = useList<QuotaView>(QUOTA_BASE, {
    scope: scopeFilter || undefined,
    exceededOnly: exceededOnly ? "true" : undefined,
    search: search || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const totalQuotas = list.meta?.total ?? list.items?.length ?? 0;

  async function submit() {
    if (!acting) return false;
    const outcome = await mutation.run(`${QUOTA_BASE}/${acting.id}/reset`, {
      method: "POST",
      body: { note: note || undefined },
      successNote: "Quota reset.",
      onDone: () => { setActing(null); setNote(""); list.refresh(); },
    });
    return outcome.ok;
  }

  const exceededCount = list.items?.filter((q) => q.state === "QUOTA_EXCEEDED").length ?? 0;
  const warnedCount = list.items?.filter((q) => q.state === "WARNED_80" || q.state === "WARNED_90").length ?? 0;

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-baseline gap-3">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-semibold text-primary">Quotas</h1>
          <div className="text-[11px] text-muted">
            {totalQuotas} quota{totalQuotas !== 1 ? "s" : ""}
          </div>
        </div>
        {exceededCount > 0 && (
          <Callout kind="danger" title={`${exceededCount} exceeded`}>
            Hard limits are active. Devices past 100% are disconnected automatically.
          </Callout>
        )}
        {warnedCount > 0 && (
          <Callout kind="warning" title={`${warnedCount} awaiting review`}>
            Devices approaching their limit are flagged for review.
          </Callout>
        )}
      </div>

      <FilterBar
        filters={[
          {
            id: "scope",
            label: "Scope",
            value: scopeFilter,
            onChange: (value: string) => { setScopeFilter(value); setPage(1); },
            options: [
              { id: "", label: "All" },
              { id: "SYSTEM", label: "System" },
              { id: "USER", label: "User" },
              { id: "DEVICE", label: "Device" },
              { id: "CONFIG", label: "Config" },
              { id: "NODE", label: "Node" },
            ],
          },
        ]}
        search={{ value: search, placeholder: "Search quotas…", onChange: setSearch }}
      />

      <AsyncPanel
        loading={list.loading}
        error={list.error}
        subject="quotas"
        onRetry={list.refresh}
        rows={14}
        label={`${totalQuotas} quota${totalQuotas !== 1 ? "s" : ""}`}
      >
        {(!list.items || list.items.length === 0) ? (
          <EmptyState
            title="No quotas"
            message="No quotas have been configured. Add a quota to begin enforcing data limits."
          />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={list.items}
              keyOf={(row) => row.quotaId}
            />
            <div className="p-3">
              <Pagination page={page} pageSize={PAGE_SIZE} total={totalQuotas} onPage={setPage} />
            </div>
          </>
        )}
      </AsyncPanel>

      <ActionModal
        open={acting !== null}
        title="Reset quota"
        description="The device quota is reset to its configured limit. The device becomes APPROVED again and can reconnect immediately."
        fields={acting
          ? [{ id: "note", label: "Operator note", kind: "textarea", value: note, onChange: setNote }]
          : []}
        submitLabel="Reset quota"
        danger={false}
        ready={!acting || true}
        busy={mutation.busy}
        error={mutation.error}
        onClose={() => { setActing(null); setNote(""); mutation.clear(); }}
        onSubmit={() => void submit()}
      />
    </div>
  );
}

const columns = [
  {
    key: "scope",
    header: "Scope",
    render: (row: QuotaView) => (
      <div>
        <div className="font-medium text-primary">{row.scope}</div>
        {row.label ? (
          <div className="font-mono text-[11px] text-faint truncate max-w-[180px] inline-block" title={row.label}>
            {row.label}
          </div>
        ) : (
          <div className="text-faint">—</div>
        )}
      </div>
    ),
  },
  {
    key: "scopeRefId",
    header: "Reference",
    render: (row: QuotaView) => (
      <span className="font-mono text-[11px] text-faint">
        {row.scopeRefId ?? <span className="text-faint">—</span>}
      </span>
    ),
  },
  {
    key: "limit",
    header: "Limit",
    align: "right" as const,
    render: (row: QuotaView) => (
      <span className="text-muted">{formatBytes(BigInt(row.limitBytes))}</span>
    ),
  },
  {
    key: "used",
    header: "Used",
    align: "right" as const,
    render: (row: QuotaView) => (
      <span className="text-muted">{formatBytes(BigInt(row.usedBytes))}</span>
    ),
  },
  {
    key: "remaining",
    header: "Remaining",
    align: "right" as const,
    render: (row: QuotaView) => (
      <span className="text-muted">{formatBytes(BigInt(row.remainingBytes))}</span>
    ),
  },
  {
    key: "percent",
    header: "% Used",
    align: "right" as const,
    render: (row: QuotaView) => (
      <div className="flex flex-col gap-1 right-align">
        <div>
          <span className="text-muted">
            {row.percent != null ? `${row.percent.toFixed(1)}%` : <span className="text-faint">unavailable</span>}
          </span>
        </div>
        {row.percent != null && (
          <UsageBar percent={row.percent} tone={quotaTone(row.state)} />
        )}
      </div>
    ),
  },
  {
    key: "state",
    header: "State",
    render: (row: QuotaView) => (
      <StatusPill tone={quotaTone(row.state)}>{row.state}</StatusPill>
    ),
  },
  {
    key: "period",
    header: "Period",
    render: (row: QuotaView) => (
      <span className="text-muted">{row.period}</span>
    ),
  },
  {
    key: "resetAt",
    header: "Reset",
    render: (row: QuotaView) => (
      <span className="text-muted">
        {row.resetAt ? formatDateTime(row.resetAt) : <span className="text-faint">manual</span>}
      </span>
    ),
  },
  {
    key: "exceededAt",
    header: "Exceeded",
    render: (row: QuotaView) => (
      <span className="text-muted">
        {row.exceededAt ? formatDateTime(row.exceededAt) : <span className="text-faint">—</span>}
      </span>
    ),
  },
  {
    key: "actions",
    header: "Actions",
    align: "right" as const,
    render: (row: QuotaView) => (
      <span className="flex justify-end gap-1.5">
        {(row.state === "QUOTA_EXCEEDED" || row.state === "WARNED_90" || row.state === "WARNED_80") && (
          <Button size="sm" onClick={() => setActing({ action: "reset", id: row.quotaId })}>
            Reset
          </Button>
        )}
      </span>
    ),
  },
];
