"use client";

import { useState } from "react";
import { Button, DataTable, EmptyState, StatusPill, Select, Input, Panel, SectionHeading, Stat, KeyValue, UsageBar, Callout } from "@/components/ui/primitives";
import { formatBytes, applySavingFormula } from "@/lib/format/units";
import { type DnsOverview, type DnsList } from "../_shared/ops-contract";
import { AsyncPanel, FilterBar, useList } from "../_shared/ops-view";

const DNS_BASE = "/api/dns";

export default function DnsPage() {
  const [search, setSearch] = useState("");
  const overview = useList<DnsOverview>(DNS_BASE, { search: search || undefined });

  const lists = overview.items?.[0]?.lists ?? [];
  const stats = overview.items?.[0]?.stats ?? null;
  const blocked = stats ? Number(formatBytes(BigInt(stats.blocked))) : 0;
  const allowed = stats ? Number(formatBytes(BigInt(stats.allowed))) : 0;
  const blockedPct = stats?.blockedPct;

  const blockedNum = stats ? Number(stats.blocked) : 0;
  const allowedNum = stats ? Number(stats.allowed) : 0;

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="flex items-baseline gap-2">
        <h1 className="text-lg font-semibold text-primary">DNS</h1>
        {lists.length > 0 && (
          <div className="text-[11px] text-muted">
            {lists.length} list{lists.length !== 1 ? "s" : ""}
          </div>
        )}
      </div>

      {overview.error && (
        <Callout kind="error" title="DNS overview unavailable">
          {overview.error.message}
        </Callout>
      )}

      <SectionHeading label="Filtering status" description="DNS-level block/allow rules are applied at the gateway, before traffic reaches the device." />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div
                className={`w-3 h-3 rounded-full ${overview.items?.[0]?.enabled ? "bg-status-success" : "bg-status-muted"}`}
              />
              <span className="text-sm font-medium text-primary">
                {overview.items?.[0]?.enabled ? "Filtering enabled" : "Filtering disabled"}
              </span>
            </div>
            <StatusPill
              tone={overview.items?.enabled ? "success" : "neutral"}
              label={overview.items?.enabled ? "Active" : "Inactive"}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-surface rounded border border-border p-3">
              <div className="text-[11px] text-muted">Blocked requests</div>
              <div className="text-primary font-medium text-lg">{blockedNum.toLocaleString()}</div>
              <div className="text-[11px] text-muted mt-1">
                {blocked > 0 ? formatBytes(BigInt(blocked.toString())) : "No data"}
              </div>
            </div>
            <div className="bg-surface rounded border border-border p-3">
              <div className="text-[11px] text-muted">Allowed requests</div>
              <div className="text-primary font-medium text-lg">{allowedNum.toLocaleString()}</div>
              <div className="text-[11px] text-muted mt-1">
                {allowed > 0 ? formatBytes(BigInt(allowed.toString())) : "No data"}
              </div>
            </div>
          </div>

          {blockedPct != null && (
            <div className="bg-surface rounded border border-border p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] text-muted">Blocked ratio</span>
                <span className="text-sm font-medium text-primary">
                  {blockedPct.toFixed(1)}%
                </span>
              </div>
              <UsageBar percent={blockedPct} tone="warning" />
            </div>
          )}

          {overview.items?.providerConfigured && (
            <div className="bg-surface rounded border border-border p-3">
              <div className="text-[11px] text-muted mb-1">DNS provider</div>
              <div className="text-sm text-primary">{overview.items?.provider ?? "system"}</div>
            </div>
          )}

          {overview.items?.disclaimer && (
            <Callout kind="info" title="About DNS statistics">
              {overview.items.disclaimer}
            </Callout>
          )}
        </Panel>

        <Panel className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-primary">Block/allow lists</h2>
            <Button onClick={() => { /* create list action */ }}>Add list</Button>
          </div>

          <AsyncPanel
            loading={overview.loading}
            error={overview.error}
            subject="dns_lists"
            onRetry={overview.refresh}
            rows={14}
            label={`${lists.length} list${lists.length !== 1 ? "s" : ""}`}
          >
            {lists.length === 0 ? (
              <EmptyState
                title="No DNS lists"
                message="No custom DNS block/allow lists have been configured. Add a list to begin filtering traffic."
              />
            ) : (
              <DataTable columns={listColumns} rows={lists} keyOf={(row) => row.id} />
            )}
          </AsyncPanel>
        </Panel>
      </div>
    </div>
  );
}

const listColumns = [
  {
    key: "name",
    header: "Name",
    render: (row: DnsList) => (
      <div>
        <div className="font-medium text-primary">{row.name}</div>
        {row.category && (
          <div className="text-[11px] text-muted">{row.category}</div>
        )}
      </div>
    ),
  },
  {
    key: "kind",
    header: "Kind",
    render: (row: DnsList) => (
      <StatusPill
        tone={row.kind === "BLOCKLIST" ? "danger" : "success"}
        label={row.kind === "BLOCKLIST" ? "Blocklist" : "Allowlist"}
      />
    ),
  },
  {
    key: "enabled",
    header: "Status",
    render: (row: DnsList) => (
      <StatusPill
        tone={row.enabled ? "success" : "neutral"}
        label={row.enabled ? "Enabled" : "Disabled"}
      />
    ),
  },
  {
    key: "entryCount",
    header: "Entries",
    align: "right" as const,
    render: (row: DnsList) => (
      <span className="text-muted">{row.entryCount?.toLocaleString() ?? "—"}</span>
    ),
  },
  {
    key: "sampleEntries",
    header: "Sample entries",
    render: (row: DnsList) => (
      <div className="flex flex-wrap gap-1">
        {row.sampleEntries && row.sampleEntries.length > 0 ? (
          row.sampleEntries.slice(0, 5).map((domain) => (
            <span key={domain} className="font-mono text-[11px] text-faint bg-surface px-1.5 rounded">
              {domain}
            </span>
          ))
        ) : (
          <span className="text-faint text-[11px]">No entries</span>
        )}
        {row.sampleEntries && row.sampleEntries.length > 5 && (
          <span className="text-[11px] text-muted">+{row.sampleEntries.length - 5} more</span>
        )}
      </div>
    ),
  },
  {
    key: "source",
    header: "Source",
    render: (row: DnsList) => (
      <span className="text-muted text-xs">
        {row.source ?? <span className="text-faint">custom</span>}
      </span>
    ),
  },
  {
    key: "updatedAt",
    header: "Updated",
    render: (row: DnsList) => (
      <span className="text-muted text-xs">
        {row.updatedAt ? new Date(row.updatedAt).toLocaleDateString() : "—"}
      </span>
    ),
  },
  {
    key: "actions",
    header: "Actions",
    align: "right" as const,
    render: (row: DnsList) => (
      <span className="flex justify-end gap-1.5">
        <Button size="sm" onClick={() => { /* edit list */ }}>Edit</Button>
        <Button size="sm" variant="danger" onClick={() => { /* delete list */ }}>
          Delete
        </Button>
      </span>
    ),
  },
];
