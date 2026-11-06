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
  expect(tmpRel("dir/a.zip", 7, 11)).toBe(".rclone-extractor-tmp/7/11/a");
  expect(trashRel("dir/a.zip", "trash")).toBe("trash/dir/a.zip");
});

test("temp paths are unique per archive with the same stem", () => {
  const first = tmpRel("one/a.zip", 3, 10);
  const second = tmpRel("two/a.tar.gz", 3, 11);
  expect(first).not.toBe(second);
  expect(first).toBe(".rclone-extractor-tmp/3/10/a");
  expect(second).toBe(".rclone-extractor-tmp/3/11/a");
});
