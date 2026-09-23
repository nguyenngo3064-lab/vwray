import "server-only";
import type { AutomationJobKind, AutomationRunStatus, Prisma } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { record } from "@/server/audit";
import { publishDomain } from "@/server/events/dispatch";
import { getSetting } from "@/server/settings/service";
import { JOB_KINDS, jobDefinitionFor } from "@/server/automation/jobs";

/**
 * Automation engine: safe scheduled work.
 *
 * A job row is a promise that work happens on a cadence. The engine behind it is three
 * things: `dueJobs()` (finds rows whose time has come), `runJob()` (leases one, runs
 * the registry handler, advances the next run, and writes BOTH bookkeeping rows and the
 * mandatory audit row), and `tick()` (the scheduler loop's single step). Work lives in
 * `jobs.ts`; scheduling policy lives here.
 *
 * The scheduler itself is in-process (`scheduler.ts`) because this installation runs one
 * control-plane process. `REDIS_URL` does not change that: the event fan-out may ride
 * Redis, but a cron-style lease in PostgreSQL is still the coordination primitive for the
 * jobs themselves.
 */

export interface AutomationJobView {
  id: string;
  name: string;
  kind: AutomationJobKind;
  label: string;
  description: string;
  enabled: boolean;
  intervalSeconds: number;
  nextRunAt: string;
  leaseUntil: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastSummary: string | null;
  failureCount: number;
  config: Record<string, unknown> | null;
  defaultIntervalSeconds: number;
  minIntervalSeconds: number;
  createdAt: string;
}

export interface AutomationRunView {
  id: string;
  jobId: string;
  jobName: string;
  kind: string;
  startedAt: string;
  finishedAt: string | null;
  status: AutomationRunStatus;
  summary: string | null;
  affectedCount: number;
  detail: unknown;
  error: string | null;
}

const LEASE_SECONDS = 600;

function viewOf(job: {
  id: string;
  name: string;
  kind: AutomationJobKind;
  enabled: boolean;
  intervalSeconds: number;
  nextRunAt: Date;
  leaseUntil: Date | null;
  lastRunAt: Date | null;
  lastStatus: AutomationRunStatus | null;
  lastSummary: string | null;
  failureCount: number;
  config: Prisma.JsonValue | null;
  createdAt: Date;
}): AutomationJobView {
  const definition = jobDefinitionFor(job.kind);
  return {
    id: job.id,
    name: job.name,
    kind: job.kind,
    label: definition.label,
    description: definition.description,
    enabled: job.enabled,
    intervalSeconds: job.intervalSeconds,
    nextRunAt: job.nextRunAt.toISOString(),
    leaseUntil: job.leaseUntil?.toISOString() ?? null,
    lastRunAt: job.lastRunAt?.toISOString() ?? null,
    lastStatus: job.lastStatus,
    lastSummary: job.lastSummary,
    failureCount: job.failureCount,
    config: (job.config ?? null) as Record<string, unknown> | null,
    defaultIntervalSeconds: definition.defaultIntervalSeconds,
    minIntervalSeconds: definition.minIntervalSeconds,
    createdAt: job.createdAt.toISOString(),
  };
}

export async function listAutomationJobs(): Promise<{ items: AutomationJobView[]; total: number }> {
  const rows = await prisma.automationJob.findMany({ orderBy: [{ enabled: "desc" }, { nextRunAt: "asc" }] });
  return { items: rows.map(viewOf), total: rows.length };
}

export async function getAutomationJob(id: string): Promise<AutomationJobView> {
  const job = await prisma.automationJob.findUnique({ where: { id } });
  if (!job) throw errors.notFound("Automation job");
  return viewOf(job);
}

export async function createAutomationJob(input: {
  name: string;
  kind: AutomationJobKind;
  intervalSeconds?: number;
  enabled?: boolean;
  config?: Record<string, unknown> | null;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<AutomationJobView> {
  if (!JOB_KINDS.includes(input.kind)) {
    throw errors.validation(`Unknown job kind. Choose one of: ${JOB_KINDS.join(", ")}.`);
  }
  const definition = jobDefinitionFor(input.kind);
  const interval = input.intervalSeconds ?? definition.defaultIntervalSeconds;
  if (interval < definition.minIntervalSeconds) {
    throw errors.validation(
      `Interval must be at least ${definition.minIntervalSeconds}s for ${input.kind}.`,
    );
  }
  if (interval > 31 * 86_400) throw errors.validation("Interval cannot exceed 31 days.");

  try {
    const created = await prisma.automationJob.create({
      data: {
        name: input.name,
        kind: input.kind,
        intervalSeconds: interval,
        nextRunAt: new Date(Date.now() + interval * 1000),
        enabled: input.enabled ?? true,
        config: (input.config ?? undefined) as Prisma.InputJsonValue | undefined,
        createdById: input.actorId,
      },
    });

    await record({
      actor: { type: "USER", id: input.actorId, label: input.actorLabel },
      action: "automation.job_created",
      resource: "automation_job",
      resourceId: created.id,
      result: "SUCCESS",
      sourceIp: input.sourceIp ?? null,
      metadata: { name: created.name, kind: created.kind, intervalSeconds: created.intervalSeconds },
    });

    return viewOf(created);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002") {
      throw errors.conflict("An automation job with that name already exists.");
    }
    throw error;
  }
}

export async function updateAutomationJob(input: {
  id: string;
  name?: string;
  intervalSeconds?: number;
  enabled?: boolean;
  config?: Record<string, unknown> | null;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<AutomationJobView> {
  const existing = await prisma.automationJob.findUnique({ where: { id: input.id } });
  if (!existing) throw errors.notFound("Automation job");
  const definition = jobDefinitionFor(existing.kind);

  if (input.intervalSeconds !== undefined && input.intervalSeconds < definition.minIntervalSeconds) {
    throw errors.validation(`Interval must be at least ${definition.minIntervalSeconds}s for ${existing.kind}.`);
  }

  const data: Prisma.AutomationJobUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.intervalSeconds !== undefined) {
    data.intervalSeconds = input.intervalSeconds;
    data.nextRunAt = new Date(Date.now() + input.intervalSeconds * 1000);
  }
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.config !== undefined) data.config = (input.config ?? undefined) as Prisma.InputJsonValue | undefined;

  const updated = await prisma.automationJob.update({ where: { id: existing.id }, data });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: existing.enabled && input.enabled === false ? "automation.job_disabled" : "automation.job_updated",
    resource: "automation_job",
    resourceId: existing.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null,
    metadata: { name: updated.name, kind: updated.kind, changed: Object.keys(data) },
  });

  return viewOf(updated);
}

/**
 * Executes one job row right now (scheduler tick or operator "run now").
 *
 * The lease clause is the concurrency control: `leaseUntil` in the future means another
 * process holds the job. The run advances `nextRunAt` from the FINISH time, never from
 * the schedule, so a long run delays rather than overlaps its successor.
 */
export async function runAutomationJob(input: {
  jobId: string;
  actorId?: string | null;
  actorLabel?: string;
  source?: "scheduler" | "console";
}): Promise<AutomationRunView> {
  const now = new Date();
  const job = await prisma.automationJob.findUnique({ where: { id: input.jobId } });
  if (!job) throw errors.notFound("Automation job");
  if (job.leaseUntil !== null && job.leaseUntil.getTime() > now.getTime()) {
    throw errors.conflict(`Job is already running (lease held until ${job.leaseUntil.toISOString()}).`);
  }

  const definition = jobDefinitionFor(job.kind);
  const config = (job.config ?? null) as Record<string, unknown> | null;

  const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000);
  await prisma.automationJob.update({ where: { id: job.id }, data: { leaseUntil } });

  const run = await prisma.automationRun.create({
    data: { jobId: job.id, status: "RUNNING" },
  });

  let status: AutomationRunStatus;
  let summary: string;
  let affected = 0;
  let detail: Prisma.InputJsonValue | undefined;
  let error: string | null = null;

  try {
    const outcome = await definition.run({ id: job.id, name: job.name, config });
    status = outcome.status;
    summary = outcome.summary;
    affected = outcome.affected;
    detail = outcome.detail as Prisma.InputJsonValue | undefined;
    error = outcome.error ?? null;
  } catch (caught) {
    status = "FAILED";
    summary = "Job handler threw an unexpected error.";
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const finishedAt = new Date();
  const finished = await prisma.automationRun.update({
    where: { id: run.id },
    data: { status, finishedAt, summary, affectedCount: affected, detail, error },
    include: { job: { select: { name: true, kind: true } } },
  });

  await prisma.automationJob.update({
    where: { id: job.id },
    data: {
      leaseUntil: null,
      lastRunAt: finishedAt,
      lastStatus: status,
      lastSummary: summary,
      failureCount: status === "FAILED" ? { increment: 1 } : 0,
      nextRunAt: new Date(finishedAt.getTime() + job.intervalSeconds * 1000),
    },
  });

  // The mandatory audit row: an automation run is never allowed to pass silently.
  await record({
    actor:
      input.actorId === null || input.actorId === undefined
        ? { type: "SYSTEM", id: null, label: input.actorLabel ?? "automation" }
        : { type: "USER", id: input.actorId, label: input.actorLabel ?? "operator" },
    action: "automation.job_run",
    resource: "automation_job",
    resourceId: job.id,
    result: status === "FAILED" ? "FAILURE" : "SUCCESS",
    metadata: {
      jobName: job.name,
      kind: job.kind,
      status,
      affectedCount: affected,
      summary,
      error,
      source: input.source ?? "console",
      automationRunId: finished.id,
    },
  });

  await publishDomain("automation.run", {
    ts: finishedAt.getTime(),
    jobId: job.id,
    jobName: job.name,
    kind: job.kind,
    status,
    summary,
    affectedCount: affected,
    error,
  });

  return {
    id: finished.id,
    jobId: finished.jobId,
    jobName: finished.job.name,
    kind: finished.job.kind,
    startedAt: finished.startedAt.toISOString(),
    finishedAt: finished.finishedAt?.toISOString() ?? null,
    status: finished.status,
    summary: finished.summary,
    affectedCount: finished.affectedCount,
    detail: finished.detail,
    error: finished.error,
  };
}

/** One scheduler tick: find due jobs and run them in kind order. */
export async function schedulerTick(now: Date = new Date()): Promise<{
  due: number;
  ran: number;
  failed: number;
  durationMs: number;
}> {
  const startedAt = Date.now();
  let enabled = true;
  try {
    enabled = await getSetting<boolean>("automation.enabled");
  } catch {
    enabled = true;
  }
  if (!enabled) return { due: 0, ran: 0, failed: 0, durationMs: Date.now() - startedAt };

  const due = await prisma.automationJob.findMany({
    where: {
      enabled: true,
      nextRunAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
    },
    orderBy: { nextRunAt: "asc" },
  });

  let ran = 0;
  let failed = 0;
  for (const job of due) {
    try {
      const result = await runAutomationJob({ jobId: job.id, actorLabel: "automation", source: "scheduler" });
      ran += 1;
      if (result.status === "FAILED") failed += 1;
    } catch {
      failed += 1;
    }
  }

  return { due: due.length, ran, failed, durationMs: Date.now() - startedAt };
}

/** Seeds one job row per registry kind (idempotent by unique name). */
export async function ensureDefaultAutomationJobs(actorId: string, actorLabel = "bootstrap"): Promise<number> {
  let created = 0;
  for (const definition of (await import("@/server/automation/jobs")).JOB_REGISTRY) {
    const existing = await prisma.automationJob.findUnique({ where: { name: definition.label } });
    if (existing) continue;
    await prisma.automationJob.create({
      data: {
        name: definition.label,
        kind: definition.kind,
        intervalSeconds: definition.defaultIntervalSeconds,
        nextRunAt: new Date(Date.now() + definition.defaultIntervalSeconds * 1000),
        enabled: true,
        createdById: actorId,
      },
    });
    created += 1;
  }
  return created;
}

export async function listAutomationRuns(filters: {
  jobId?: string;
  status?: AutomationRunStatus;
  page?: number;
  pageSize?: number;
}): Promise<{ items: AutomationRunView[]; total: number }> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 25));
  const where: Prisma.AutomationRunWhereInput = {
    ...(filters.jobId ? { jobId: filters.jobId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.automationRun.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { job: { select: { name: true, kind: true } } },
    }),
    prisma.automationRun.count({ where }),
  ]);
  return {
    items: rows.map((row) => ({
      id: row.id,
      jobId: row.jobId,
      jobName: row.job.name,
      kind: row.job.kind,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      status: row.status,
      summary: row.summary,
      affectedCount: row.affectedCount,
      detail: row.detail,
      error: row.error,
    })),
    total,
  };
}
