import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: "file:./.tmp/test.db",
      DIONYSUS_BUSINESS_ID: "", // tasks set identity explicitly; empty by default
    },
    testTimeout: 15000,
    fileParallelism: false,
  },
});
