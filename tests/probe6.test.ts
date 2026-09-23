import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { prisma, resetDatabase } from "./helpers/db";

describe("probe isolation 6", () => {
  it("sees only its own row", async () => {
    await resetDatabase();
    await prisma.notification.create({
      data: { severity: "INFO", type: "probe", title: "probe", body: "probe" },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await prisma.notification.count()).toBe(1);
  });
});
