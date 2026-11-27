import { test, expect } from "bun:test";
import {
  baseNameOf,
  dirOfRel,
  stageLabel,
  stateClass,
  jobStatusClass,
  jobPillClass,
  positiveId,
} from "../src/domain";

test("path helpers handle root-level and nested archives", () => {
  expect(baseNameOf("show.zip")).toBe("show.zip");
  expect(baseNameOf("series/show.part1.rar")).toBe("show.part1.rar");
  expect(dirOfRel("show.zip")).toBe("");
  expect(dirOfRel("series/season/show.rar")).toBe("series/season");
  expect(baseNameOf("")).toBe("");
});

test("stage and job labels are shared across the progress and logs views", () => {
  expect(stageLabel("queueing")).toBe("Building queue");
  expect(stageLabel("custom-stage")).toBe("custom-stage");
  expect(stateClass("error", true)).toBe("is-error");
  expect(stateClass("idle", true)).toBe("is-running");
  expect(stateClass("finished", false)).toBe("is-done");
  expect(jobStatusClass("skipped")).toBe("is-interrupted");
  expect(jobStatusClass("queued")).toBe("");
  expect(jobPillClass("failed")).toBe("err");
  expect(jobPillClass("active")).toBe("");
});

test("route ids accept only positive safe integers", () => {
  expect(positiveId("42")).toBe(42);
  for (const raw of ["", "0", "-1", "1.5", "abc", null, undefined]) {
    expect(positiveId(raw)).toBeNull();
  }
});
