import { test, expect } from "bun:test";
import {
  isSupported,
  stem,
  multiVolumePart,
  selectExtractor,
} from "../src/archive";

test("selectExtractor: rclone-native formats always use rclone", () => {
  for (const [name, enabled] of [["a.zip", false], ["a.zip", true], ["a.tar.gz", true], ["a.tar", true], ["a.tbz2", true]] as const) {
    expect(selectExtractor(name, enabled)).toBe("rclone");
  }
});

test("selectExtractor: rar/7z/iso use rclonex only when enabled", () => {
  for (const name of ["a.rar", "A.RAR", "a.7z", "a.iso", "A.ISO"]) {
    expect(selectExtractor(name, false)).toBe("rclone");
    expect(selectExtractor(name, true)).toBe("rclonex");
  }
});

test("selectExtractor: multivolume archives use rclonex only when enabled", () => {
  for (const name of ["a.part1.rar", "a.part01.rar", "a.7z.001"]) {
    expect(selectExtractor(name, false)).toBe("rclone");
    expect(selectExtractor(name, true)).toBe("rclonex");
  }
});

test("selectExtractor: non-first volumes stay on rclone (they are never queued)", () => {
  expect(selectExtractor("a.part2.rar", true)).toBe("rclone");
  expect(selectExtractor("a.7z.002", true)).toBe("rclone");
  expect(selectExtractor("a.r00", true)).toBe("rclone");
});

test("selectExtractor: unsupported formats stay on rclone (and are filtered elsewhere)", () => {
  expect(selectExtractor("a.sqfs", true)).toBe("rclone");
  expect(selectExtractor("a.txt", true)).toBe("rclone");
  expect(selectExtractor("a.zip.001", true)).toBe("rclone");
});

test("multiVolumePart detects rar/7z multivolume shapes", () => {
  expect(multiVolumePart("a.part1.rar")).toEqual({ kind: "rar", index: 1 });
  expect(multiVolumePart("a.part01.rar")).toEqual({ kind: "rar", index: 1 });
  expect(multiVolumePart("a.PART17.RAR")).toEqual({ kind: "rar", index: 17 });
  expect(multiVolumePart("a.7z.001")).toEqual({ kind: "7z", index: 1 });
  expect(multiVolumePart("a.7z.010")).toEqual({ kind: "7z", index: 10 });
  expect(multiVolumePart("a.r00")).toEqual({ kind: "rar", index: 100 });
  expect(multiVolumePart("a.r39")).toEqual({ kind: "rar", index: 139 });
  expect(multiVolumePart("a.rar")).toBeNull();
  expect(multiVolumePart("a.7z")).toBeNull();
  expect(multiVolumePart("a.iso")).toBeNull();
  expect(multiVolumePart("a.part1.7z")).toBeNull();
});

test("isSupported: rclonex formats only when enabled, first volume only", () => {
  expect(isSupported("a.rar")).toBe(false);
  expect(isSupported("a.7z")).toBe(false);
  expect(isSupported("a.iso")).toBe(false);
  expect(isSupported("a.rar", true)).toBe(true);
  expect(isSupported("a.7z", true)).toBe(true);
  expect(isSupported("a.iso", true)).toBe(true);
  expect(isSupported("a.part1.rar", true)).toBe(true);
  expect(isSupported("a.part01.rar", true)).toBe(true);
  expect(isSupported("a.part2.rar", true)).toBe(false);
  expect(isSupported("a.part10.rar", true)).toBe(false);
  expect(isSupported("a.r00", true)).toBe(false);
  expect(isSupported("a.r99", true)).toBe(false);
  expect(isSupported("a.7z.001", true)).toBe(true);
  expect(isSupported("a.7z.002", true)).toBe(false);
  expect(isSupported("a.7Z.001", true)).toBe(true);
  expect(isSupported("a.zip", true)).toBe(true);
  expect(isSupported("a.tar.zst", true)).toBe(true);
  expect(isSupported("a.zip")).toBe(true);
});

test("stem strips archive suffixes and multivolume markers", () => {
  expect(stem("dir/a.part1.rar")).toBe("a");
  expect(stem("a.part01.rar")).toBe("a");
  expect(stem("a.7z.001")).toBe("a");
  expect(stem("a.r00")).toBe("a");
  expect(stem("a.rar")).toBe("a");
  expect(stem("a.7z")).toBe("a");
  expect(stem("a.iso")).toBe("a");
  expect(stem("dir/a.tar.gz")).toBe("a");
  expect(stem("plain-name")).toBe("plain-name");
});
