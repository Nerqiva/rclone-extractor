import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs before any test module is imported, so config.ts sees a clean, isolated
// environment regardless of test file order.
if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rx-test-"));
}
if (!process.env.SECRET_KEY) {
  process.env.SECRET_KEY = "test-secret-key";
}
if (!process.env.APP_PASSWORD) {
  process.env.APP_PASSWORD = "test-pw";
}
