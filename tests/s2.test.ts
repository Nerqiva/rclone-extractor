import { test, expect } from "bun:test";
import { isSupported, tmpRel, parentRel, stem, trashRel } from "../src/archive";

test("supported", () => {
  expect(isSupported("a.zip")).toBe(true);
  expect(isSupported("a.tar.zst")).toBe(true);
  expect(isSupported("x.rar")).toBe(false);
  expect(isSupported("y.sqfs")).toBe(false);
});

test("paths", () => {
  expect(stem("dir/a.tar.gz")).toBe("a");
  expect(parentRel("dir/a.zip")).toBe("dir");
  expect(parentRel("a.zip")).toBe("");
  expect(tmpRel("dir/a.zip", 7)).toBe(".rclone-extractor-tmp/7/a");
  expect(trashRel("dir/a.zip", "trash")).toBe("trash/dir/a.zip");
});
