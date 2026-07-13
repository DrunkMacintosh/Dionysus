// Business provisioning CLI — a thin operator wrapper over the validated idempotent core.
//   node scripts/provision-business.mjs <id> <name> <ownerEmail> [maxTokensPerDay]
// Prints a one-line summary + a NEXT-STEPS hint (issue a login link via cockpit). Operator
// output, so it prints (the sweep/issue-login-link convention). Exits 1 with the validation
// message on bad input. No secrets are printed (there are none in a provision).
import { provisionBusiness } from "../dist/tools/provision.js";

const [id, name, ownerEmail, rawCap] = process.argv.slice(2);
if (!id || !name || !ownerEmail) {
  console.error("usage: node scripts/provision-business.mjs <id> <name> <ownerEmail> [maxTokensPerDay]");
  process.exit(1);
}

try {
  const input = { id, name, ownerEmail };
  if (rawCap !== undefined) input.maxTokensPerDay = Number(rawCap);

  const res = await provisionBusiness(input);

  console.log(
    `provisioned ${res.businessId} (${res.created ? "created" : "updated"}) — owner ${res.ownerEmail}, cap ${res.maxTokensPerDay} tokens/day`,
  );
  console.log(
    `NEXT: issue a login link — node packages/cockpit/scripts/issue-login-link.mjs ${res.businessId} ${res.ownerEmail}`,
  );
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
