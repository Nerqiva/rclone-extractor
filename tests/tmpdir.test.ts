import { test, expect } from "bun:test";
import {
  parseTmpDir,
  tmpRootPath,
  tmpTopSegment,
  tmpStemDir,
  tmpRunDir,
  tmpArchiveDir,
  TMP_DIR,
  TMP_RUN_DIR_RE,
} from "../src/tmpdir";

const ROOT = "remote:bucket";
const TRASH = "trash";

test("default relative value is accepted", () => {
  const spec = parseTmpDir(TMP_DIR, ROOT, TRASH);
  expect(spec).toEqual({ kind: "relative", value: ".Rclone-Extractor-tmp" });
});

test("nested relative value is accepted and normalized", () => {
  expect(parseTmpDir("tmp/deep/work/", ROOT, TRASH)).toEqual({
    kind: "relative",
    value: "tmp/deep/work",
  });
  expect(parseTmpDir("./tmp", ROOT, TRASH)).toEqual({ kind: "relative", value: "tmp" });
});

test("absolute remote path is preserved", () => {
  expect(parseTmpDir("myremote:path/to/tmp", ROOT, TRASH)).toEqual({
    kind: "absolute",
    value: "myremote:path/to/tmp",
  });
  // A bare remote ("remote:") names the root of the remote: using it as a
  // temp dir would put scratch data at the top level of the remote, so it
  // is refused.
  expect(parseTmpDir("remote:", ROOT, TRASH)).toBeNull();
});

test("absolute local path is preserved", () => {
  expect(parseTmpDir("/mnt/nas/tmp", ROOT, TRASH)).toEqual({
    kind: "absolute",
    value: "/mnt/nas/tmp",
  });
  expect(parseTmpDir("/", ROOT, TRASH)).toBeNull();
});

test("absolute tmp overlapping the scan root is refused", () => {
  // With a local scan root, an absolute temp dir that contains or equals
  // the scan root (or its trash dir) is refused.
  expect(parseTmpDir("/", "/data/scan", "trash")).toBeNull();
  expect(parseTmpDir("/data", "/data/scan", "trash")).toBeNull();
  expect(parseTmpDir("/data/scan", "/data/scan", "trash")).toBeNull();
  expect(parseTmpDir("/data/scan/tmp", "/data/scan", "trash")).toBeNull();
  expect(parseTmpDir("/data/scan-trash", "/data/scan", "trash")).not.toBeNull();
  expect(parseTmpDir("/data/tmp", "/data/scan", "trash")).not.toBeNull();
});

test("empty values are rejected (caller falls back to default)", () => {
  expect(parseTmpDir("", ROOT, TRASH)).toBeNull();
  expect(parseTmpDir("   ", ROOT, TRASH)).toBeNull();
});

test("dot segments are rejected", () => {
  expect(parseTmpDir(".", ROOT, TRASH)).toBeNull();
  expect(parseTmpDir("a/./b", ROOT, TRASH)).toBeNull();
  expect(parseTmpDir("..", ROOT, TRASH)).toBeNull();
  expect(parseTmpDir("a/../../b", ROOT, TRASH)).toBeNull();
});

test("refusing to overlap the scan root or the trash dir", () => {
  expect(parseTmpDir("remote:bucket", ROOT, TRASH)).toBeNull();
  expect(parseTmpDir(TRASH, ROOT, TRASH)).toBeNull();
  expect(parseTmpDir("trash/archives", ROOT, TRASH)).toBeNull();
  expect(parseTmpDir("trash/subdir", ROOT, "trash/subdir")).toBeNull();
  expect(parseTmpDir("tmp", ROOT, TRASH)).not.toBeNull();
});

test("tmpRootPath resolves relative paths against the root", () => {
  expect(tmpRootPath(ROOT, { kind: "relative", value: "tmp" })).toBe("remote:bucket/tmp");
  expect(tmpRootPath(ROOT, { kind: "absolute", value: "/abs/tmp" })).toBe("/abs/tmp");
  expect(tmpRootPath(ROOT, { kind: "absolute", value: "remote:base/tmp" })).toBe("remote:base/tmp");
});

test("tmpTopSegment is the first segment for relative specs, null for absolute", () => {
  expect(tmpTopSegment({ kind: "relative", value: ".Rclone-Extractor-tmp" })).toBe(".Rclone-Extractor-tmp");
  expect(tmpTopSegment({ kind: "relative", value: "a/b/c" })).toBe("a");
  expect(tmpTopSegment({ kind: "absolute", value: "/abs/tmp" })).toBeNull();
});

test("run/archive/stem path layout", () => {
  expect(tmpRunDir("root/tmp", 42)).toBe("root/tmp/run_42");
  expect(tmpArchiveDir("root/tmp", 42, 7)).toBe("root/tmp/run_42/7");
  expect(tmpStemDir("root/tmp", 42, 7, "archive")).toBe("root/tmp/run_42/7/archive");
});

test("TMP_RUN_DIR_RE matches only app-owned run dirs", () => {
  expect(TMP_RUN_DIR_RE.test("run_1")).toBe(true);
  expect(TMP_RUN_DIR_RE.test("run_12345")).toBe(true);
  expect(TMP_RUN_DIR_RE.test("123")).toBe(false);
  expect(TMP_RUN_DIR_RE.test("keep-me")).toBe(false);
  expect(TMP_RUN_DIR_RE.test("run_")).toBe(false);
  expect(TMP_RUN_DIR_RE.test("run_x")).toBe(false);
});
