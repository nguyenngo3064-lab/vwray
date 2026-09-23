import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { paginationFrom, readJson, withConsole } from "@/server/http/guard";
import { errors } from "@/server/lib/errors";
import { record } from "@/server/audit";
import {
  approveDevice,
  blockDevice,
  disconnectDevice,
  rejectDevice,
  updateDevice,
} from "@/server/devices/service";
import { resetQuota } from "@/server/quota/engine";

const bulkSchema = z.object({
  action: z.enum([
    "approve",
    "reject",
    "block",
    "unblock",
    "disconnect",
    "reset-quota",
    "assign-node",
    "assign-profile",
  ]),
  ids: z.array(z.string().min(1).max(64)).min(1).max(200),
  note: z.string().max(300).optional().nullable(),
  reason: z.string().max(300).optional().nullable(),
  nodeId: z.string().min(1).max(64).optional().nullable(),
  profileId: z.string().min(1).max(64).optional().nullable(),
});

interface BulkOutcome {
  id: string;
  ok: boolean;
  error: string | null;
}

export const POST = withConsole(
  async (request, ctx) => {
    const parsed = bulkSchema.safeParse(await readJson(request));
    if (!parsed.success) throw errors.validation("The bulk payload is invalid.");

    const { action, ids } = parsed.data;
    const actor = {
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    };

    const results: BulkOutcome[] = [];
    for (const id of ids) {
      try {
        switch (action) {
          case "approve":
            await approveDevice({ deviceId: id, note: parsed.data.note, nodeId: parsed.data.nodeId, ...actor });
            break;
          case "reject":
            await rejectDevice({ deviceId: id, note: parsed.data.note, ...actor });
            break;
          case "block":
            await blockDevice({ deviceId: id, reason: parsed.data.reason ?? "Blocked by operator", ...actor });
            break;
          case "unblock": {
            const { unblockDevice } = await import("@/server/quota/engine");
            await unblockDevice({ deviceId: id, reason: parsed.data.reason ?? "Unblocked by operator", ...actor });
            break;
          }
          case "disconnect":
            await disconnectDevice({ deviceId: id, reason: parsed.data.reason ?? "revoked", ...actor });
            break;
          case "reset-quota":
            await resetQuota({ quotaId: id, ...actor });
            break;
          case "assign-node":
            if (!parsed.data.nodeId) throw errors.validation("nodeId is required for assign-node.");
            await updateDevice({ deviceId: id, assignedNodeId: parsed.data.nodeId, ...actor });
            break;
          case "assign-profile":
            if (!parsed.data.profileId) throw errors.validation("profileId is required for assign-profile.");
            await updateDevice({ deviceId: id, optimizationProfileId: parsed.data.profileId, ...actor });
            break;
        }
        results.push({ id, ok: true, error: null });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "The request failed.";
        results.push({ id, ok: false, error: message });
      }
    }

    const affected = results.filter((result) => result.ok).length;
    await record({
      actor: { type: "USER", id: actor.actorId, label: actor.actorLabel },
      action: "device.bulk_action",
      resource: "device",
      result: "SUCCESS",
      sourceIp: actor.sourceIp,
      metadata: { action, requested: ids.length, affected, failed: ids.length - affected },
    });

    return jsonOk(
      { affected, failed: ids.length - affected, results },
      { requestId: ctx.requestId },
    );
  },
  { role: "ADMIN" },
);
