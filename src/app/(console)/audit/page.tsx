"use client";

import { useState } from "react";
import { DataTable, EmptyState, Panel, StatusPill, type TableColumn } from "@/components/ui/primitives";
import { AsyncPanel, FilterBar, useList } from "../_shared/ops-view";

/**
 * Activity — the operator audit trail.
 *
 * Read-only view over `/api/audit`. Only redacted metadata ever reaches this
 * page (the writer strips passwords, tokens and sealed payloads before storing).
 */

interface AuditRow {
  id: string;
  ts: string;
  actorType: string;
  actorLabel: string;
  action: string;
  resource: string;
  result: "SUCCESS" | "FAILURE" | "DENIED";
  sourceIp: string | null;
}

function resultTone(result: string): "success" | "warning" | "danger" | "neutral" {
  if (result === "SUCCESS") return "success";
  if (result === "FAILURE") return "warning";
  if (result === "DENIED") return "danger";
  return "neutral";
}

const columns: Array<TableColumn<AuditRow>> = [
  { key: "ts", header: "Time", render: (row) => <span className="font-mono text-[11px]">{new Date(row.ts).toLocaleString()}</span> },
  { key: "action", header: "Action", render: (row) => <span className="font-mono text-[11.5px]">{row.action}</span> },
  { key: "actor", header: "Actor", render: (row) => `${row.actorType} · ${row.actorLabel}` },
  { key: "result", header: "Result", render: (row) => <StatusPill tone={resultTone(row.result)} label={row.result} /> },
  { key: "sourceIp", header: "Source IP", render: (row) => row.sourceIp ?? "—" },
];

export default function AuditPage() {
  const [action, setAction] = useState("");
  const [result, setResult] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const list = useList<AuditRow>("/api/audit", {
    action: action || undefined,
    result: result || undefined,
    q: search || undefined,
    page,
    pageSize: 25,
  });

  const facets = (list.rawMeta as { facets?: { actions?: string[] } } | null)?.facets;

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Activity</h1>
        <p className="text-[12.5px] text-muted">
          Every privileged action leaves a row here: logins, node approvals, token rotations, config changes.
        </p>
      </div>

      <Panel title="Filters" bodyClassName="p-0">
        <FilterBar
          filters={[
            {
              id: "action",
              label: "Action",
              value: action,
              onChange: (value: string) => { setAction(value); setPage(1); },
              options: [
                { id: "", label: "All" },
                ...(facets?.actions ?? []).map((entry) => ({ id: entry, label: entry })),
              ],
            },
            {
              id: "result",
              label: "Result",
              value: result,
              onChange: (value: string) => { setResult(value); setPage(1); },
              options: [
                { id: "", label: "All" },
                { id: "SUCCESS", label: "SUCCESS" },
                { id: "FAILURE", label: "FAILURE" },
                { id: "DENIED", label: "DENIED" },
              ],
            },
          ]}
          search={{
            value: search,
            placeholder: "Search actions, actors, resources...",
            onChange: (value: string) => { setSearch(value); setPage(1); },
          }}
        />
      </Panel>

      <AsyncPanel loading={list.loading} error={list.error} subject="audit rows" onRetry={list.refresh}>
        <DataTable
          rows={list.items}
          columns={columns}
          keyOf={(row) => row.id}
          empty={
            <EmptyState title="No activity yet" message="Audit rows appear here as soon as operators and nodes act." />
          }
        />
      </AsyncPanel>
    </div>
  );
}
