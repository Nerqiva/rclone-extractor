import { test, expect } from "bun:test";
import { resolveOutcome } from "../src/runs";

test("stored outcome wins over legacy flags", () => {
  expect(
    resolveOutcome({ outcome: "error", interrupted: 1, finished_at: "t" }),
  ).toBe("error");
  expect(
    resolveOutcome({ outcome: "interrupted", interrupted: 1, finished_at: "t" }),
  ).toBe("interrupted");
});

test("legacy rows fall back to the interrupted flag (killed)", () => {
  expect(resolveOutcome({ outcome: "", interrupted: 1, finished_at: "t" })).toBe(
    "killed",
  );
  expect(resolveOutcome({ outcome: null, interrupted: 1, finished_at: null })).toBe(
    "killed",
  );
});

test("finished_at without outcome or flag resolves to finished", () => {
  expect(resolveOutcome({ outcome: "", interrupted: 0, finished_at: "t" })).toBe(
    "finished",
  );
  expect(
    resolveOutcome({ outcome: null, interrupted: null, finished_at: "t" }),
  ).toBe("finished");
});

test("no signal at all resolves to empty", () => {
  expect(resolveOutcome({ outcome: "", interrupted: 0, finished_at: null })).toBe(
    "",
  );
  expect(
    resolveOutcome({ outcome: null, interrupted: null, finished_at: null }),
  ).toBe("");
});
