import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { errors } from "@/server/lib/errors";
import { gigabytesToBytes } from "@/lib/format/units";
import { getSetting } from "@/server/settings/service";
import { listQuotas, setQuota } from "@/server/quota/engine";

export const GET = withConsole(async (_request, ctx) => {
  const scope = ctx.url.searchParams.get("scope") ?? undefined;
  const exceededOnly = ctx.url.searchParams.get("exceededOnly") === "true";
  const items = await listQuotas({ scope, exceededOnly });
  const [thresholds, enforcementEnabled] = await Promise.all([
    getSetting<number[]>("quota.warnThresholds"),
    getSetting<boolean>("quota.enforcementEnabled"),
  ]);
  return jsonOk(
    {
      items: items.map((item) => ({
        ...item,
        limitBytes: item.limitBytes.toString(),
        usedBytes: item.usedBytes.toString(),
        remainingBytes: item.remainingBytes.toString(),
        exceededAt: item.exceededAt ? item.exceededAt.toISOString() : null,
        resetAt: item.resetAt ? item.resetAt.toISOString() : null,
        warned80At: item.warned80At ? item.warned80At.toISOString() : null,
        warned90At: item.warned90At ? item.warned90At.toISOString() : null,
      })),
      thresholds,
      enforcementEnabled,
      graceBytes: "0",
      resetSchedule: { autoResetEnabled: false },
    },
    { requestId: ctx.requestId },
  );
});

const createSchema = z.object({
  scope: z.enum(["SYSTEM", "USER", "DEVICE", "CONFIG", "NODE"]),
  scopeRefId: z.string().min(1).max(64).nullable().optional(),
  label: z.string().min(1).max(120),
  limitGb: z.coerce.number().min(0).max(1_000_000),
  period: z.enum(["DAILY", "WEEKLY", "MONTHLY", "CUSTOM"]),
  resetPolicy: z.enum(["AUTO", "MANUAL"]).optional(),
  resetAt: z.string().max(40).optional().nullable(),
  enabled: z.boolean().optional(),
  graceGb: z.coerce.number().min(0).max(1_000_000).optional(),
});

export const POST = withConsole(
  async (request, ctx) => {
    const parsed = createSchema.safeParse(await readJson(request));
    if (!parsed.success) throw errors.validation("The quota payload is invalid.");
    const resetAt = parsed.data.resetAt ? new Date(parsed.data.resetAt) : null;
    if (parsed.data.resetAt && resetAt && Number.isNaN(resetAt.getTime())) {
      throw errors.validation("resetAt must be an ISO timestamp.");
    }
    const id = await setQuota({
      scope: parsed.data.scope,
      scopeRefId: parsed.data.scopeRefId ?? null,
      label: parsed.data.label,
      limitBytes: gigabytesToBytes(parsed.data.limitGb),
      period: parsed.data.period,
      resetPolicy: parsed.data.resetPolicy ?? "MANUAL",
      resetAt,
      enabled: parsed.data.enabled ?? true,
      graceBytes: parsed.data.graceGb !== undefined ? gigabytesToBytes(parsed.data.graceGb) : undefined,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });
    return jsonOk({ id }, { status: 201, requestId: ctx.requestId });
  },
  { role: "ADMIN" },
);
