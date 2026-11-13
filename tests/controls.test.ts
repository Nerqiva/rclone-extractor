import { test, expect, beforeEach } from "bun:test";
import { controlsFragment } from "../src/views";
import { engineState } from "../src/engine";

beforeEach(() => {
  engineState.running = false;
  engineState.stopRequested = false;
  engineState.forceStop = false;
  engineState.stage = "idle";
  engineState.activity = "";
  engineState.archiveInFlight = false;
});

test("idle shows the Start button", () => {
  const html = controlsFragment();
  expect(html).toContain("Start");
  expect(html).not.toContain("run in progress");
  expect(html).not.toContain("Force stop");
  expect(html).not.toContain("Stopping…");
});

test("running shows the Stop button that opens the stop modal", () => {
  engineState.running = true;
  const html = controlsFragment();
  expect(html).toContain(">Stop</button>");
  expect(html).toContain('data-modal-open="stop-modal"');
  expect(html).toContain("run in progress");
  expect(html).not.toContain("Force stop");
});

test("soft-stop requested shows a persistent note and the modal Stop button", () => {
  engineState.running = true;
  engineState.stopRequested = true;
  const html = controlsFragment();
  expect(html).toContain('data-modal-open="stop-modal"');
  expect(html).toContain("Stop requested");
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

test("idle shows the reuse checkbox unchecked and a Start button", () => {
  const html = controlsFragment();
  expect(html).toContain('name="reuse_scan" value="1"');
  expect(html).toContain("Reuse previous scan results");
  expect(html).not.toContain('name="reuse_scan" value="1" checked');
  expect(html).not.toContain("Skip listing");
});

test("listing stage shows Skip listing only", () => {
  engineState.running = true;
  engineState.stage = "listing";
  engineState.activity = "Listing archives";
  const html = controlsFragment();
  expect(html).toContain("Skip listing");
  expect(html).not.toContain("Skip archive");
  expect(html).not.toContain("Skip inspection");
});

test("between archives shows no skip controls", () => {
  engineState.running = true;
  engineState.stage = "extracting";
  engineState.activity = "";
  engineState.archiveInFlight = false;
  const html = controlsFragment();
  expect(html).not.toContain("Skip listing");
  expect(html).not.toContain("Skip archive");
  expect(html).not.toContain("Skip inspection");
});

test("queueing stage shows no skip controls", () => {
  engineState.running = true;
  engineState.stage = "queueing";
  const html = controlsFragment();
  expect(html).not.toContain("Skip listing");
  expect(html).not.toContain("Skip archive");
  expect(html).not.toContain("Skip inspection");
});

test("while rclone inspects an archive, Skip inspection and Skip archive are shown", () => {
  engineState.running = true;
  engineState.stage = "extracting";
  engineState.activity = "Inspecting archive";
  engineState.archiveInFlight = true;
  const html = controlsFragment();
  expect(html).toContain("Skip inspection");
  expect(html).toContain("Skip archive");
  expect(html).not.toContain("Skip listing");
});

test("extracting an archive shows only Skip archive", () => {
  engineState.running = true;
  engineState.stage = "extracting";
  engineState.activity = "Extracting";
  engineState.archiveInFlight = true;
  const html = controlsFragment();
  expect(html).toContain("Skip archive");
  expect(html).not.toContain("Skip inspection");
  expect(html).not.toContain("Skip listing");
});
