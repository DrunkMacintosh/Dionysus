import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      // Note 1 (orchestrator): SAME value stage 1 uses. Prisma resolves `file:`
      // URLs against the SCHEMA dir (packages/dionysus-mcp/prisma/), not CWD, so
      // this reaches the shared stage-1 test DB from the department package too.
      DATABASE_URL: "file:./.tmp/test.db",
      DIONYSUS_BUSINESS_ID: "", // tasks set identity explicitly; empty by default
    },
    testTimeout: 15000,
    fileParallelism: false,
  },
});
