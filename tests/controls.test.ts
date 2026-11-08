import { test, expect, beforeEach } from "bun:test";
import { controlsFragment } from "../src/routes/actions";
import { engineState } from "../src/engine";

beforeEach(() => {
  engineState.running = false;
  engineState.stopRequested = false;
  engineState.forceStop = false;
});

test("idle shows the Start button", () => {
  const html = controlsFragment();
  expect(html).toContain("Start");
  expect(html).not.toContain("run in progress");
  expect(html).not.toContain("Force stop");
  expect(html).not.toContain("Stopping…");
});

test("running shows the Stop button with a toast on click", () => {
  engineState.running = true;
  const html = controlsFragment();
  expect(html).toContain(">Stop</button>");
  expect(html).toContain("/run/stop");
  expect(html).toContain("run in progress");
  expect(html).not.toContain("Force stop");
});

test("soft-stop requested shows Force stop plus a persistent note", () => {
  engineState.running = true;
  engineState.stopRequested = true;
  const html = controlsFragment();
  expect(html).toContain("Force stop");
  expect(html).toContain("Stop requested");
  expect(html).toContain("every 1s"); // fragment polls itself until resolved
  expect(html).not.toContain("run in progress…</span>");
});

test("force stop shows a disabled stopping state that polls itself", () => {
  engineState.running = true;
  engineState.stopRequested = true;
  engineState.forceStop = true;
  const html = controlsFragment();
  expect(html).toContain("Stopping…");
  expect(html).toContain("disabled");
  expect(html).toContain("is-loading");
  expect(html).toContain("every 1s");
});
