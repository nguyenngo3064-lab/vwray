"use client";

/**
 * Client-safe response shapes for billing, budgets, receipts, security, audit
 * and settings. Byte counts are decimal strings; money values are numbers in the
 * currency the API states. Fields absent from the contract stay optional.
 */

/* -------------------------------------------------------------- billing --- */

export interface CostScopeTotal {
  key?: string;
  label?: string;
  computedCost?: number;
  costWithoutOptimization?: number;
  savedCost?: number;
  billableGb?: number;
  rawBytes?: string;
}

export interface BillingOverviewPayload {
  simulationEnabled: boolean;
  simulationNotice: string;
  pricing: {
    currency: string;
    baseFee: number;
    pricePerGb: number;
    freeQuotaGb: number;
    billingPeriod: string;
    periodStartDay: number;
    providerLabel: string;
    configId: string | null;
    persisted: boolean;
  };
  period: { start: string; end: string; elapsedDays: number; totalDays: number };
  totals: {
    rawBytes: string;
    optimizedBytes: string;
    savedBytes: string;
    savingPct: number | null;
    billableGb: number;
    freeQuotaGb: number;
    baseFee: number;
    pricePerGb: number;
    currency: string;
    computedCost: number;
    costWithoutOptimization: number;
    savedCost: number;
    formula: string;
  };
  scopes: {
    device: CostScopeTotal[];
    user: CostScopeTotal[];
    node: CostScopeTotal[];
    category: CostScopeTotal[];
  };
  projection: {
    available: boolean;
    projectedCost: number | null;
    reason: string | null;
    minimumDays: number;
    elapsedDays: number;
  };
  storedCostRecords: Array<{
    id: string;
    scope: string;
    label: string;
    periodStart: string;
    periodEnd: string;
    rawBytes: string;
    optimizedBytes: string;
    savedBytes: string;
    billableGb: number;
    computedCost: number;
    costWithoutOptimization: number;
    savedCost: number;
    currency: string;
    inputHash: string;
    source: string;
    computedAt: string;
  }>;
  dataAvailable: boolean;
  source: string;
}

export interface BillingForecastData {
  available: boolean;
  reason?: string | null;
  currentPeriodCost?: string | number | null;
  projectedCost?: string | number | null;
  elapsedDays?: number | null;
  periodDays?: number | null;
  source?: string | null;
  calculation?: string | null;
}

export interface BudgetRecord {
  id: string;
  name: string;
  amountLimit: string | number;
  currency?: string | null;
  scope?: string | null;
  period?: string | null;
  periodStartDay?: number | null;
  usedAmount?: string | number | null;
  currentAmount?: string | number | null;
  spentAmount?: string | number | null;
  percentUsed?: number | null;
  createdAt?: string | null;
}

export interface BudgetEventRecord {
  id: string;
  ts?: string | null;
  createdAt?: string | null;
  budgetId?: string | null;
  budgetName?: string | null;
  type?: string | null;
  message?: string | null;
  thresholdPct?: number | null;
}

/* ------------------------------------------------------------- receipts --- */

export interface ReceiptRecord {
  id: string;
  receiptNumber: string;
  customerName: string;
  customerRef: string | null;
  deviceLabel: string | null;
  configLabel: string | null;
  nodeLabel: string | null;
  periodStart: string;
  periodEnd: string;
  rawBytes: string;
  optimizedBytes: string;
  savedBytes: string;
  savingPct: number | null;
  savingsKind: string;
  pricePerGb: number;
  baseFee: number;
  freeQuotaGb: number;
  billableGb: number;
  simulatedTotal: number;
  currency: string;
  verificationHash: string;
  verifyUrl: string;
  stampEnabled: boolean;
  stampText: string | null;
  providerLabel: string;
  disclaimer: string;
  status: "DRAFT" | "ISSUED" | "VOID";
  source: "REAL" | "MOCK";
  generatedAt: string;
}

export interface ReceiptVerification {
  valid: boolean;
  receiptNumber: string;
  generatedAt: string;
  simulatedTotal: number;
  currency: string;
  rawBytes: string;
  optimizedBytes: string;
  savedBytes: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  providerLabel: string;
  stampEnabled: boolean;
  disclaimer: string;
  integrity: { algorithm: string; hash: string; matches: boolean; canonicalMatches: boolean };
  platformStatement: string;
  checkedAt: string;
}

/* -------------------------------------------------------------- security -- */

export interface SecurityOverviewPayload {
  failedLogins: { count: number; windowHours: number };
  activeSessions: number;
  lockedAccounts: number;
  blockedDevices: number;
  revokedCredentials: number;
  openAnomalies: number;
  unreadOnly: number;
  recentSecurityEvents: Array<{
    ts: string;
    action: string;
    result: string;
    actorLabel: string;
    resource: string;
  }>;
  policyActions: Array<{ ts: string; policyName: string; actionKey: string; targetLabel: string }>;
}

/* ---------------------------------------------------------------- audit --- */

export interface AuditItem {
  id: string;
  ts: string;
  action: string;
  resource: string;
  resourceId: string | null;
  result: string;
  actorLabel: string | null;
  actorType: string | null;
  sourceIp: string | null;
  requestId: string | null;
  metadata: unknown;
}

export interface AuditPageData {
  items: AuditItem[];
  total: number;
}

/* ------------------------------------------------------------- settings --- */

export interface SettingItem {
  key: string;
  category: string;
  description: string;
  impact: string | null;
  sensitive: boolean;
  value: unknown;
  defaultValue: unknown;
  isDefault: boolean;
  shape: "boolean" | "number" | "string" | "list" | "object";
}

export const SETTING_CATEGORIES = [
  "GENERAL",
  "AUTH",
  "SECURITY",
  "VPN",
  "NODES",
  "TRAFFIC",
  "QUOTA",
  "OPTIMIZATION",
  "DNS",
  "BILLING",
  "RECEIPTS",
  "NOTIFICATIONS",
  "RETENTION",
  "SYSTEM",
] as const;
