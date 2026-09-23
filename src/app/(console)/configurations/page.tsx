"use client";

import { useState } from "react";
import { Button, DataTable, EmptyState, Pagination, StatusPill, Select, Input, Panel, type TableColumn } from "@/components/ui/primitives";
import {
  formatDateTime,
  configStatusTone,
  type ConfigRow,
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
const CONFIGS_BASE = "/api/configs";

export default function ConfigurationsPage() {
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [acting, setActing] = useState<{ action: "revoke" | "regenerate"; id?: string } | null>(null);
  const [changeNote, setChangeNote] = useState("");
  const mutation = useActionRunner();
  const columns = configColumns((action, id) => setActing({ action, id }));

  const list = useList<ConfigRow>(CONFIGS_BASE, {
    status: statusFilter || undefined,
    search: search || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const totalConfigs = list.meta.total;
  const activeCount = list.items?.filter((c) => c.status === "ACTIVE").length ?? 0;

  async function submit() {
    if (!acting) return false;
    if (!acting.id) {
      mutation.setError(new Error("No configuration selected."));
      return false;
    }
    let outcome: Awaited<ReturnType<typeof mutation.run>>;
    if (acting.action === "revoke") {
      outcome = await mutation.run(`${CONFIGS_BASE}/${acting.id}`, {
        method: "DELETE",
        body: { note: changeNote || undefined },
        successNote: "Configuration revoked.",
        onDone: () => { setActing(null); setChangeNote(""); list.refresh(); },
      });
    } else {
      outcome = await mutation.run(`${CONFIGS_BASE}/${acting.id}/regenerate`, {
        method: "POST",
        body: { note: changeNote || undefined },
        successNote: "Configuration regenerated.",
        onDone: () => { setActing(null); setChangeNote(""); list.refresh(); },
      });
    }
    return outcome.ok;
  }

  const singleFields: ActionField[] = acting
    ? [{ id: "changeNote", label: "Change note" , kind: "textarea", value: changeNote, onChange: setChangeNote }]
    : [];

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-baseline gap-3">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-semibold text-primary">Configurations</h1>
          <div className="text-[11px] text-muted">
            {totalConfigs} config{totalConfigs !== 1 ? "s" : ""} · {activeCount} active
          </div>
        </div>
      </div>

      <FilterBar
        filters={[
          {
            id: "status",
            label: "Status",
            value: statusFilter,
            onChange: (value: string) => { setStatusFilter(value); setPage(1); },
            options: [
              { id: "", label: "All" },
              { id: "ACTIVE", label: "Active" },
              { id: "SUSPENDED", label: "Suspended" },
              { id: "REVOKED", label: "Revoked" },
              { id: "EXPIRED", label: "Expired" },
            ],
          },
        ]}
        search={{ value: search, placeholder: "Search configurations…", onChange: setSearch }}
      />

      <AsyncPanel
        loading={list.loading}
        error={list.error}
        subject="configurations"
        onRetry={list.refresh}
        rows={14}
        label={`${totalConfigs} config${totalConfigs !== 1 ? "s" : ""}`}
      >
        {(!list.items || list.items.length === 0) ? (
          <EmptyState
            title="No configurations"
            message="No VPN configurations have been generated. Generate a configuration for an approved device to begin."
          />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={list.items}
              keyOf={(row) => row.id}
            />
            <div className="p-3">
              <Pagination page={page} pageSize={PAGE_SIZE} total={totalConfigs} onPage={setPage} />
            </div>
          </>
        )}
      </AsyncPanel>

      <ActionModal
        open={acting !== null}
        title={acting ? (acting.action === "revoke" ? "Revoke configuration" : "Regenerate configuration") : ""}
        description={acting?.action === "revoke"
          ? "The configuration is revoked immediately. Connected devices lose access once the agent acknowledges the revocation."
          : "A new configuration payload is generated. The previous version is retained for rollback."}
        fields={singleFields}
        submitLabel={acting?.action === "revoke" ? "Revoke" : "Regenerate"}
        danger={acting?.action === "revoke"}
        ready={true}
        busy={mutation.busy}
        error={mutation.error}
        onClose={() => { setActing(null); setChangeNote(""); mutation.clear(); }}
        onSubmit={() => void submit()}
      />
    </div>
  );
}

/** See `nodeColumns`: the action column takes a callback so the array stays module-level. */
function configColumns(
  onAct: (action: "revoke" | "regenerate", id: string) => void,
): TableColumn<ConfigRow>[] {
  return [
  {
    key: "name",
    header: "Name",
    render: (row: ConfigRow) => (
      <div>
        <div className="font-medium text-primary">{row.name}</div>
        <div className="font-mono text-[11px] text-faint">{row.id}</div>
      </div>
    ),
  },
  {
    key: "protocol",
    header: "Protocol",
    render: (row: ConfigRow) => (
      <span className="text-muted">{row.protocol}</span>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (row: ConfigRow) => (
      <StatusPill tone={configStatusTone(row.status)}>{row.status}</StatusPill>
    ),
  },
  {
    key: "version",
    header: "Version",
    align: "right" as const,
    render: (row: ConfigRow) => (
      <span className="text-muted">v{row.version}</span>
    ),
  },
  {
    key: "device",
    header: "Device",
    render: (row: ConfigRow) => (
      <span className="text-muted">
        {row.device ? (
          <span>{row.device.displayName}</span>
        ) : (
          <span className="text-faint">—</span>
        )}
      </span>
    ),
  },
  {
    key: "node",
    header: "Node",
    render: (row: ConfigRow) => (
      <span className="text-muted">
        {row.node ? (
          <span>{row.node.name}</span>
        ) : (
          <span className="text-faint">—</span>
        )}
      </span>
    ),
  },
  {
    key: "expiresAt",
    header: "Expires",
    render: (row: ConfigRow) => (
      <span className="text-muted">
        {row.expiresAt ? formatDateTime(row.expiresAt) : <span className="text-faint">no expiry</span>}
      </span>
    ),
  },
  {
    key: "createdAt",
    header: "Created",
    render: (row: ConfigRow) => (
      <span className="text-muted">{formatDateTime(row.createdAt)}</span>
    ),
  },
  {
    key: "actions",
    header: "Actions",
    align: "right" as const,
    render: (row: ConfigRow) => (
      <span className="flex justify-end gap-1.5">
        {row.status === "ACTIVE" && (
          <>
            <Button size="sm" onClick={() => onAct("regenerate", row.id)}>
              Regenerate
            </Button>
            <Button size="sm" variant="danger" onClick={() => onAct("revoke", row.id)}>
              Revoke
            </Button>
          </>
        )}
      </span>
    ),
  },
  ];
}
