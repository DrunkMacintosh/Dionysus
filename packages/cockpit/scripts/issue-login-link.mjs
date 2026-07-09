import { createHash, randomBytes } from "node:crypto";
import { prisma } from "dionysus-mcp/db";

const [businessId, email] = process.argv.slice(2);
if (!businessId || !email) {
  console.error("usage: node scripts/issue-login-link.mjs <businessId> <email>");
  process.exit(1);
}
const business = await prisma.business.findUnique({ where: { id: businessId } });
if (!business) {
  console.error(`Business ${businessId} not found.`);
  process.exit(1);
}
const token = randomBytes(32).toString("base64url");
await prisma.magicLink.create({ data: {
  businessId, email,
  tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
  expiresAt: new Date(Date.now() + 15 * 60 * 1000),
} });
console.log(`${process.env.COCKPIT_BASE_URL ?? "http://localhost:3000"}/auth/${token}`);
process.exit(0);
