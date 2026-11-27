import { test, expect } from "bun:test";
import {
  isSupported,
  stem,
  multiVolumePart,
  isRclonexFormat,
} from "../src/archive";

test("isRclonexFormat: rclone-native formats are not rclonex formats", () => {
  for (const name of ["a.zip", "A.ZIP", "a.tar.gz", "a.tar", "a.tbz2"]) {
    expect(isRclonexFormat(name)).toBe(false);
  }
});

test("isRclonexFormat: rar/7z/iso are rclonex formats", () => {
  for (const name of ["a.rar", "A.RAR", "a.7z", "a.iso", "A.ISO"]) {
    expect(isRclonexFormat(name)).toBe(true);
  }
});

test("isRclonexFormat: only the first multivolume part qualifies", () => {
  for (const name of ["a.part1.rar", "a.part01.rar", "a.7z.001"]) {
    expect(isRclonexFormat(name)).toBe(true);
  }
  expect(isRclonexFormat("a.part2.rar")).toBe(false);
  expect(isRclonexFormat("a.7z.002")).toBe(false);
  expect(isRclonexFormat("a.r00")).toBe(false);
});

test("isRclonexFormat: unsupported formats are not rclonex formats", () => {
  expect(isRclonexFormat("a.sqfs")).toBe(false);
  expect(isRclonexFormat("a.txt")).toBe(false);
  expect(isRclonexFormat("a.zip.001")).toBe(false);
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

test("isSupported: first volume only, rclonex formats always supported", () => {
  expect(isSupported("a.rar")).toBe(true);
  expect(isSupported("a.7z")).toBe(true);
  expect(isSupported("a.iso")).toBe(true);
  expect(isSupported("a.rar")).toBe(true);
  expect(isSupported("a.7z")).toBe(true);
  expect(isSupported("a.iso")).toBe(true);
  expect(isSupported("a.part1.rar")).toBe(true);
  expect(isSupported("a.part01.rar")).toBe(true);
  expect(isSupported("a.part2.rar")).toBe(false);
  expect(isSupported("a.part10.rar")).toBe(false);
  expect(isSupported("a.r00")).toBe(false);
  expect(isSupported("a.r99")).toBe(false);
  expect(isSupported("a.7z.001")).toBe(true);
  expect(isSupported("a.7z.002")).toBe(false);
  expect(isSupported("a.7Z.001")).toBe(true);
  expect(isSupported("a.zip")).toBe(true);
  expect(isSupported("a.tar.zst")).toBe(true);
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
