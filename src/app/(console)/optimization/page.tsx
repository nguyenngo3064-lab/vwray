"use client";

import { useState } from "react";
import { Button, DataTable, EmptyState, StatusPill, Select, Input, Panel, SectionHeading } from "@/components/ui/primitives";
import { savingKindTone, type OptimizationProfile, type OptimizationOverview } from "../_shared/ops-contract";
import { AsyncPanel, useList } from "../_shared/ops-view";

const OPT_BASE = "/api/optimization";

export default function OptimizationPage() {
  const overview = useList<OptimizationOverview>(OPT_BASE, {});
  const profiles = overview.items?.profiles ?? [];
  const targetRange = overview.items?.targetRange;

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="flex items-baseline gap-2">
        <h1 className="text-lg font-semibold text-primary">Optimization</h1>
        {profiles.length > 0 && (
          <div className="text-[11px] text-muted">
            {profiles.length} profile{profiles.length !== 1 ? "s" : ""}
          </div>
        )}
      </div>

      <SectionHeading
        label="Overview"
        description="Traffic optimization profiles control how the gateway processes and filters traffic."
      />

      {targetRange && (
        <Panel className="space-y-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-medium text-primary">Target saving range</h2>
            <div className="text-[11px] text-muted">
              {targetRange.min}% – {targetRange.max}% reduction, depending on traffic type
            </div>
          </div>
          <p className="text-[12px] text-muted leading-relaxed">
            Actual savings depend on the nature of the traffic. Encrypted, already-compressed, or binary payloads often yield little benefit. Savings are measured, not guaranteed.
          </p>
        </Panel>
      )}

      <SectionHeading label="Profiles" description={`${profiles.length} profile${profiles.length !== 1 ? "s" : ""}`} />

      <AsyncPanel
        loading={overview.loading}
        error={overview.error}
        subject="optimization_profiles"
        onRetry={overview.refresh}
        rows={14}
        label={`${profiles.length} profile${profiles.length !== 1 ? "s" : ""}`}
      >
        {profiles.length === 0 ? (
          <EmptyState
            title="No optimization profiles"
            message="No optimization profiles are configured."
          />
        ) : (
          <DataTable columns={columns} rows={profiles} keyOf={(row) => row.id} />
        )}
      </AsyncPanel>
    </div>
  );
}

const columns = [
  {
    key: "key",
    header: "Key",
    render: (row: OptimizationProfile) => (
      <span className="font-mono text-xs">{row.key}</span>
    ),
  },
  {
    key: "name",
    header: "Name",
    render: (row: OptimizationProfile) => (
      <span className="text-primary">{row.name}</span>
    ),
  },
  {
    key: "description",
    header: "Description",
    render: (row: OptimizationProfile) => (
      <span className="text-muted text-xs">{row.description}</span>
    ),
  },
  {
    key: "dnsFilteringLevel",
    header: "DNS filtering",
    render: (row: OptimizationProfile) => (
      <span className="text-muted text-xs">{row.dnsFilteringLevel}</span>
    ),
  },
  {
    key: "compressionEnabled",
    header: "Compression",
    render: (row: OptimizationProfile) => (
      <span className="text-muted text-xs">{row.compressionEnabled ? "Enabled" : "Disabled"}</span>
    ),
  },
  {
    key: "mediaOptimization",
    header: "Media optimization",
    render: (row: OptimizationProfile) => (
      <span className="text-muted text-xs">{row.mediaOptimization ? "Enabled" : "Disabled"}</span>
    ),
  },
  {
    key: "latencyPriority",
    header: "Latency priority",
    render: (row: OptimizationProfile) => (
      <span className="text-muted text-xs">{row.latencyPriority ? "Enabled" : "Disabled"}</span>
    ),
  },
  {
    key: "udpStability",
    header: "UDP stability",
    render: (row: OptimizationProfile) => (
      <span className="text-muted text-xs">{row.udpStability ? "Enabled" : "Disabled"}</span>
    ),
  },
  {
    key: "enabled",
    header: "Enabled",
    render: (row: OptimizationProfile) => (
      <StatusPill
        tone={row.enabled ? "success" : "neutral"}
        label={row.enabled ? "Enabled" : "Disabled"}
      />
    ),
  },
  {
    key: "deviceCount",
    header: "Devices",
    align: "right" as const,
    render: (row: OptimizationProfile) => (
      <span className="text-muted">{row.deviceCount}</span>
    ),
  },
];
