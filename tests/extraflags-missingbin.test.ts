import { test, expect, beforeAll } from "bun:test";

/**
 * Validation degrades to a warning when the binary cannot be probed. Fresh
 * process so config.ts captures the missing paths at import time.
 */
let validateExtraFlags: typeof import("../src/extraflags").validateExtraFlags;
let field: import("../src/extraflags").ExtraFlagField;

beforeAll(async () => {
  process.env.RCLONE_BIN = "/nonexistent/path/to/rclone";
  process.env.RCLONEX_BIN = "/nonexistent/path/to/rclonex";
  const mod = await import("../src/extraflags");
  validateExtraFlags = mod.validateExtraFlags;
  field = mod.EXTRA_FLAG_FIELDS.find((f) => f.key === "rclonex_extract_extra_flags")!;
});

test("missing binary allows the save with a clear warning", async () => {
  const result = await validateExtraFlags(field, "--fast-list");
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.warning).toContain("saved without validation");
    expect(result.warning).toContain("rclonex_extract_extra_flags");
  }
});
