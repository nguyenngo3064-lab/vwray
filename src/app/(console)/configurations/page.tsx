"use client";

import { useState } from "react";
import { Button, DataTable, EmptyState, Pagination, StatusPill, Select, Panel, type TableColumn } from "@/components/ui/primitives";
import {
  formatDateTime,
  configStatusTone,
  type DeviceRow,
  type ConfigRow,
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
const CONFIGS_BASE = "/api/configs";

export default function ConfigurationsPage() {
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [acting, setActing] = useState<{ action: "revoke" | "regenerate"; id?: string } | null>(null);
  const [changeNote, setChangeNote] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [protocol, setProtocol] = useState("WIREGUARD");
  const [generated, setGenerated] = useState<{ payload: string; format: string; summary: string } | null>(null);
  const mutation = useActionRunner();
  const columns = configColumns((action, id) => setActing({ action, id }));

  const list = useList<ConfigRow>(CONFIGS_BASE, {
    status: statusFilter || undefined,
    search: search || undefined,
    page,
    pageSize: PAGE_SIZE,
  });
  const devices = useList<DeviceRow>("/api/devices", { approvalState: "APPROVED", pageSize: 100 });
  const nodes = useList<NodeRow>("/api/nodes", { health: "ONLINE", pageSize: 100 });

  const totalConfigs = list.meta.total;
  const activeCount = list.items?.filter((c) => c.status === "ACTIVE").length ?? 0;

  async function generateConfiguration() {
    const selectedDeviceId = deviceId || devices.items[0]?.id || "";
    const selectedNodeId = nodeId || nodes.items[0]?.id || "";
    if (!selectedDeviceId || !selectedNodeId) {
      mutation.setError(new Error("Choose an approved device and an online node first."));
      return;
    }
    const outcome = await mutation.run<{ payload: string; format: string; summary: string }>(CONFIGS_BASE, {
      body: { deviceId: selectedDeviceId, nodeId: selectedNodeId, protocol },
      successNote: "Configuration generated.",
      onDone: () => list.refresh(),
    });
    if (outcome.ok) {
      setGenerated(outcome.data);
      if (protocol === "WIREGUARD") {
        try {
          await navigator.clipboard.writeText(outcome.data.payload);
        } catch {
          // Clipboard permission can be unavailable in an embedded browser.
        }
        window.location.href = "wireguard://";
      }
    }
  }

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

      <Panel title="Generate client profile" bodyClassName="space-y-3 p-4">
        <div className="grid gap-3 lg:grid-cols-[1fr_1fr_12rem_auto] lg:items-end">
          <label className="space-y-1">
            <span className="micro-label block">Approved device</span>
            <Select value={deviceId || devices.items[0]?.id || ""} onChange={(event) => setDeviceId(event.target.value)}>
              <option value="">Choose device</option>
              {devices.items.map((device) => <option key={device.id} value={device.id}>{device.displayName}</option>)}
            </Select>
          </label>
          <label className="space-y-1">
            <span className="micro-label block">Online node</span>
            <Select value={nodeId || nodes.items[0]?.id || ""} onChange={(event) => setNodeId(event.target.value)}>
              <option value="">Choose node</option>
              {nodes.items.map((node) => <option key={node.id} value={node.id}>{node.name} · {node.publicEndpoint}</option>)}
            </Select>
          </label>
          <label className="space-y-1">
            <span className="micro-label block">Protocol</span>
            <Select value={protocol} onChange={(event) => setProtocol(event.target.value)}>
              <option value="WIREGUARD">WireGuard</option>
              <option value="XRAY_VLESS">Xray VLESS</option>
              <option value="XRAY_VMESS">Xray VMess</option>
              <option value="XRAY_TROJAN">Xray Trojan</option>
            </Select>
          </label>
          <Button variant="primary" onClick={() => void generateConfiguration()} disabled={mutation.busy}>
            {mutation.busy ? "Generating..." : protocol === "WIREGUARD" ? "Generate & Open WireGuard" : "Generate"}
          </Button>
        </div>
        {!devices.loading && devices.items.length === 0 ? (
          <p className="text-[12px] text-warning">No approved devices. Approve a device from Devices first.</p>
        ) : null}
        {!nodes.loading && nodes.items.length === 0 ? (
          <p className="text-[12px] text-warning">No online nodes. Register a VPN node and wait for its heartbeat.</p>
        ) : null}
        {mutation.error ? <p className="text-[12px] text-danger" role="alert">{mutation.error}</p> : null}
        {generated ? (
          <div className="space-y-2 border-t border-border pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[12px] text-success">{generated.summary}</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void navigator.clipboard.writeText(generated.payload)}>Copy</Button>
                {generated.format === "wireguard" ? (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      void navigator.clipboard.writeText(generated.payload);
                      window.location.href = "wireguard://";
                    }}
                    title="Copy the profile, then open the WireGuard app"
                  >
                    Open WireGuard
                  </Button>
                ) : null}
                <Button size="sm" onClick={() => {
                  const blob = new Blob([generated.payload], { type: "text/plain" });
                  const href = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = href;
                  link.download = `vwray-${generated.format}.conf`;
                  link.click();
                  URL.revokeObjectURL(href);
                }}>Download</Button>
              </div>
            </div>
            <textarea readOnly value={generated.payload} className="input min-h-40 w-full resize-y font-mono text-[11px]" aria-label="Generated configuration" />
            {generated.format === "wireguard" ? (
              <p className="text-[11.5px] leading-relaxed text-faint">
                Open WireGuard copies the profile first and opens the installed app. If the app does not open automatically, use Download and import the .conf file from WireGuard.
              </p>
            ) : null}
          </div>
        ) : null}
      </Panel>

      <Panel title="Installation guide" bodyClassName="space-y-3 p-4 text-[12px] leading-relaxed text-muted">
        <details open>
          <summary className="cursor-pointer font-medium text-primary">WireGuard on Android</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>Install the official WireGuard app.</li>
            <li>Tap <span className="text-primary">+</span>, choose import from file or QR code, then load the generated profile.</li>
            <li>Review the endpoint and AllowedIPs, save, and activate the tunnel.</li>
          </ol>
        </details>
        <details>
          <summary className="cursor-pointer font-medium text-primary">WireGuard on iOS</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>Install WireGuard from the App Store.</li>
            <li>Choose Add a tunnel, then scan a QR code or import the downloaded profile.</li>
            <li>Allow the VPN permission and switch the tunnel on.</li>
          </ol>
        </details>
        <details>
          <summary className="cursor-pointer font-medium text-primary">NPV Tunnel</summary>
          <p className="mt-2">Use NPV Tunnel only with a profile format it supports. WireGuard profiles should be imported through WireGuard on Android or iOS; never paste a private key into chat or a public form.</p>
        </details>
        <p className="border-t border-border pt-3 text-faint">Only approved devices and online nodes appear in the generator. Revoking a profile stops future use; disconnect or block the device from Devices.</p>
      </Panel>

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
