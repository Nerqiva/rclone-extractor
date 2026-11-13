import { test, expect } from "bun:test";
import { formatBytes, formatRate, formatDuration } from "../src/format";

test("formatBytes", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1024)).toBe("1.00 KiB");
  expect(formatBytes(1536)).toBe("1.50 KiB");
  expect(formatBytes(10 * 1024 ** 2)).toBe("10.0 MiB");
  expect(formatBytes(1024 ** 4)).toBe("1.00 TiB");
  expect(formatBytes(NaN)).toBe("—");
  expect(formatBytes(-1)).toBe("—");
});

test("formatRate", () => {
  expect(formatRate(null)).toBe("—");
  expect(formatRate(NaN)).toBe("—");
  expect(formatRate(2048)).toBe("2.00 KiB/s");
});

test("formatDuration", () => {
  expect(formatDuration(NaN)).toBe("—");
  expect(formatDuration(0)).toBe("—");
  expect(formatDuration(-5)).toBe("—");
  expect(formatDuration(1_000)).toBe("0m 01s");
  expect(formatDuration(65_000)).toBe("1m 05s");
  expect(formatDuration(3_725_000)).toBe("1h 02m 05s");
  expect(formatDuration(NaN, "running")).toBe("running");
});
