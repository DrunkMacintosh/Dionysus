// Resets the throwaway test DB without prisma's destructive --force-reset:
// delete the SQLite file, then a plain (non-destructive) db push recreates it.
//
// NOTE: prisma resolves relative SQLite URLs against the schema directory
// (prisma/), not the package root — both the CLI and the generated client
// agree on this — so "file:./.tmp/test.db" is really prisma/.tmp/test.db.
import { mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const DB_DIR = "prisma/.tmp";

mkdirSync(DB_DIR, { recursive: true });

for (const f of [`${DB_DIR}/test.db`, `${DB_DIR}/test.db-journal`]) {
  rmSync(f, { force: true });
}

execSync("pnpm prisma db push --skip-generate", {
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? "file:./.tmp/test.db",
  },
});
