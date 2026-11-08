import { test, expect } from "bun:test";
import { parseStatsLine } from "../src/rclone";

test("parses a standard stats-one-line with date/level prefix", () => {
  const line =
    "2026/11/08 12:00:00 INFO  :   512.345 MiB / 1.000 GiB, 50%, 12.3 MiB/s, ETA 43s";
  const s = parseStatsLine(line);
  expect(s).not.toBeNull();
  expect(s?.bytesDone).toBeCloseTo(512.345 * 1024 * 1024, 0);
  expect(s?.bytesTotal).toBe(1024 * 1024 * 1024);
  expect(s?.percent).toBe(50);
  expect(s?.speedBytesPerSec).toBeCloseTo(12.3 * 1024 * 1024, 0);
  expect(s?.etaText).toBe("43s");
});

test("parses a blank prefix and xfr suffix", () => {
  const line = "  1.000 GiB / 2.000 GiB, 50%, 30.5 MiB/s, ETA 1m30s (xfr#1/2)";
  const s = parseStatsLine(line);
  expect(s).not.toBeNull();
  expect(s?.bytesDone).toBe(1024 * 1024 * 1024);
  expect(s?.etaText).toBe("1m30s");
});

test("dash percent and dash ETA yield nulls/empties", () => {
  const line = "0 B / 0 B, -%, 0 B/s, ETA -";
  const s = parseStatsLine(line);
  expect(s).not.toBeNull();
  expect(s?.percent).toBeNull();
  expect(s?.etaText).toBe("");
});

test("returns null for non-stats lines", () => {
  expect(parseStatsLine("")).toBeNull();
  expect(parseStatsLine("NOTICE: archive list failed (exit 1)")).toBeNull();
  expect(parseStatsLine("Extracting foo.zip: 1234 files")).toBeNull();
});

test("all zero speed parses", () => {
  const line = "0 B / 1.500 GiB, 0%, 0 B/s, ETA -";
  const s = parseStatsLine(line);
  expect(s).not.toBeNull();
  expect(s?.speedBytesPerSec).toBe(0);
  expect(s?.percent).toBe(0);
});
