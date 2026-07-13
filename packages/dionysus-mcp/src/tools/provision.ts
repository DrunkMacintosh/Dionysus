// Business provisioning (D31 dogfood) — the operator's first step: a VALIDATED,
// IDEMPOTENT Business upsert at platform-operator level (like the sweep; no ambient
// identity). Validate FIRST so an invalid input throws and writes NOTHING; then upsert
// by id — re-running updates name/ownerEmail/maxTokensPerDay and never duplicates or
// destroys child rows. Prints nothing (the thin CLI is the operator output surface).
import { prisma } from "../db.js";

export type ProvisionInput = { id: string; name: string; ownerEmail: string; url?: string; maxTokensPerDay?: number };
export type ProvisionResult = { businessId: string; created: boolean; name: string; ownerEmail: string; maxTokensPerDay: number };

// id: lowercase slug; ownerEmail: a deliberately simple shape check (presence, not deliverability).
const ID_RE = /^[a-z0-9_-]{3,40}$/;
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const DEFAULT_MAX_TOKENS_PER_DAY = 100000;

/**
 * Throw on any invalid field BEFORE touching the database, so a rejected provision
 * writes nothing. Checks: id slug, name non-empty, email shape, positive-integer cap.
 */
function validate(input: ProvisionInput): void {
  if (!ID_RE.test(input.id)) {
    throw new Error(`invalid id "${input.id}" — must match /^[a-z0-9_-]{3,40}$/`);
  }
  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw new Error("invalid name — must be non-empty.");
  }
  if (!EMAIL_RE.test(input.ownerEmail)) {
    throw new Error(`invalid ownerEmail "${input.ownerEmail}" — must look like an address.`);
  }
  if (input.maxTokensPerDay !== undefined && (!Number.isInteger(input.maxTokensPerDay) || input.maxTokensPerDay <= 0)) {
    throw new Error(`invalid maxTokensPerDay ${input.maxTokensPerDay} — must be a positive integer.`);
  }
}

/**
 * Idempotently provision a Business. Validates first (invalid → throws, nothing written),
 * then upserts by id: `created` reflects whether the row was new (a findUnique-before on
 * this sequential operator path). The update touches only name/ownerEmail/maxTokensPerDay —
 * child rows (objectives, routes, …) are never destroyed.
 *
 * Note: `url` is accepted for interface stability but the current Business schema has no
 * url column and this stage adds no schema change, so it is not persisted.
 */
export async function provisionBusiness(input: ProvisionInput): Promise<ProvisionResult> {
  validate(input);

  const { id } = input;
  const name = input.name.trim();
  const { ownerEmail } = input;
  const maxTokensPerDay = input.maxTokensPerDay ?? DEFAULT_MAX_TOKENS_PER_DAY;

  const existing = await prisma.business.findUnique({ where: { id } });
  const created = existing === null;

  await prisma.business.upsert({
    where: { id },
    create: { id, name, ownerEmail, maxTokensPerDay },
    update: { name, ownerEmail, maxTokensPerDay },
  });

  return { businessId: id, created, name, ownerEmail, maxTokensPerDay };
}
