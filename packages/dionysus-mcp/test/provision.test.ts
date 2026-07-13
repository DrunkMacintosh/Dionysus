import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/db.js";
import { provisionBusiness } from "../src/tools/provision.js";

// Namespaced operator-test tenant — satisfies the id slug rule /^[a-z0-9_-]{3,40}$/.
const BIZ = "provision-test-a";

// Wipe the tenant between tests: child rows first (FK), then the business row itself.
async function wipe(id: string): Promise<void> {
  await prisma.objective.deleteMany({ where: { businessId: id } });
  await prisma.business.deleteMany({ where: { id } });
}

beforeEach(async () => {
  await wipe(BIZ);
});

describe("provisionBusiness — validated idempotent onboarding", () => {
  it("creates a new business: created:true with the given fields, persisted", async () => {
    const res = await provisionBusiness({
      id: BIZ,
      name: "Provision Test A",
      ownerEmail: "founder@example.com",
      maxTokensPerDay: 50000,
    });

    expect(res).toEqual({
      businessId: BIZ,
      created: true,
      name: "Provision Test A",
      ownerEmail: "founder@example.com",
      maxTokensPerDay: 50000,
    });

    const row = await prisma.business.findUnique({ where: { id: BIZ } });
    expect(row).not.toBeNull();
    expect(row!.name).toBe("Provision Test A");
    expect(row!.ownerEmail).toBe("founder@example.com");
    expect(row!.maxTokensPerDay).toBe(50000);
  });

  it("defaults maxTokensPerDay to 100000 when omitted", async () => {
    const res = await provisionBusiness({ id: BIZ, name: "A", ownerEmail: "a@b.co" });

    expect(res.maxTokensPerDay).toBe(100000);
    const row = await prisma.business.findUnique({ where: { id: BIZ } });
    expect(row!.maxTokensPerDay).toBe(100000);
  });

  it("re-provisions idempotently: created:false, cap updated, seeded child objective untouched", async () => {
    await provisionBusiness({
      id: BIZ,
      name: "First Name",
      ownerEmail: "first@example.com",
      maxTokensPerDay: 100000,
    });

    // Seed a child objective under the business before re-provisioning.
    const obj = await prisma.objective.create({
      data: { businessId: BIZ, kind: "growth", target: "100 signups", metric: "signups", status: "active" },
    });

    const res = await provisionBusiness({
      id: BIZ,
      name: "Second Name",
      ownerEmail: "second@example.com",
      maxTokensPerDay: 250000,
    });

    expect(res.created).toBe(false);
    expect(res.maxTokensPerDay).toBe(250000);
    expect(res.name).toBe("Second Name");
    expect(res.ownerEmail).toBe("second@example.com");

    // Updated in place — never duplicated.
    const rows = await prisma.business.findMany({ where: { id: BIZ } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.maxTokensPerDay).toBe(250000);
    expect(rows[0]!.name).toBe("Second Name");

    // The child objective still exists, unchanged (upsert never destroys child rows).
    const stillThere = await prisma.objective.findUnique({ where: { id: obj.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere!.target).toBe("100 signups");
    expect(stillThere!.status).toBe("active");
  });

  it("throws on invalid input and writes NOTHING", async () => {
    const cases: Array<{ label: string; input: Parameters<typeof provisionBusiness>[0]; id: string }> = [
      { label: "bad slug (uppercase + space)", input: { id: "Bad Slug!", name: "X", ownerEmail: "x@y.co" }, id: "Bad Slug!" },
      { label: "bad slug (too short)", input: { id: "ab", name: "X", ownerEmail: "x@y.co" }, id: "ab" },
      { label: "bad email", input: { id: BIZ, name: "X", ownerEmail: "not-an-email" }, id: BIZ },
      { label: "non-positive cap", input: { id: BIZ, name: "X", ownerEmail: "x@y.co", maxTokensPerDay: 0 }, id: BIZ },
      { label: "non-integer cap", input: { id: BIZ, name: "X", ownerEmail: "x@y.co", maxTokensPerDay: 1.5 }, id: BIZ },
      { label: "empty name", input: { id: BIZ, name: "   ", ownerEmail: "x@y.co" }, id: BIZ },
    ];

    for (const c of cases) {
      await expect(provisionBusiness(c.input), c.label).rejects.toThrow();
      const row = await prisma.business.findUnique({ where: { id: c.id } });
      expect(row, `${c.label} must write nothing`).toBeNull();
    }
  });
});
