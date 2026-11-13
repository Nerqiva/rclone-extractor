import { test, expect } from "bun:test";
import {
  isSupported,
  stem,
  isTrashPath,
  normalizeRel,
  escapeLike,
  createArchiveStats,
  addArchiveEntry,
  classifyArchive,
} from "../src/archive";
import { parseArchiveListLine, redactArgs } from "../src/rclone";
import { isSafeRel } from "../src/archive";

test("supported", () => {
  expect(isSupported("a.zip")).toBe(true);
  expect(isSupported("a.tar.zst")).toBe(true);
  expect(isSupported("x.rar")).toBe(false);
  expect(isSupported("y.sqfs")).toBe(false);
});

test("paths", () => {
  expect(stem("dir/a.tar.gz")).toBe("a");
});

test("isTrashPath excludes only the top-level trash subdir", () => {
  expect(isTrashPath("trash/a.zip", "trash")).toBe(true);
  expect(isTrashPath("trash/nested/a.zip", "trash")).toBe(true);
  expect(isTrashPath("trash/a.zip", "trash/")).toBe(true);
  expect(isTrashPath("trashy/a.zip", "trash")).toBe(false);
  expect(isTrashPath("./trash/a.zip", "trash")).toBe(true);
  expect(isTrashPath("a/trash/b.zip", "trash")).toBe(false);
  expect(isTrashPath("archive/trash/b.zip", "archive/trash")).toBe(true);
  expect(isTrashPath("a.zip", "")).toBe(false);
});

test("normalizeRel trims prefixes/suffixes and escapeLike escapes LIKE metacharacters", () => {
  expect(normalizeRel("./a/b/")).toBe("a/b");
  expect(normalizeRel("/a/b/")).toBe("a/b");
  expect(normalizeRel("trash")).toBe("trash");
  expect(escapeLike("100%_x\\y")).toBe("100\\%\\_x\\\\y");
});

function statsFor(entries: [string, number][]) {
  const stats = createArchiveStats();
  for (const [path, size] of entries) addArchiveEntry(stats, path, size);
  return stats;
}

test("classifyArchive: empty archive", () => {
  expect(classifyArchive(statsFor([]))).toBe("empty");
});

test("classifyArchive: >=60% .torrent", () => {
  expect(
    classifyArchive(statsFor([
      ["a.torrent", 1000],
      ["b.torrent", 1000],
      ["c.torrent", 1000],
      ["big.bin", 200_000],
    ])),
  ).toBe("torrent");
  // 3 of 6 is below the threshold
  expect(
    classifyArchive(statsFor([
      ["a.torrent", 1000],
      ["b.torrent", 1000],
      ["c.torrent", 1000],
      ["d.bin", 200_000],
      ["e.bin", 200_000],
      ["f.bin", 200_000],
    ])),
  ).toBeNull();
});

test("classifyArchive: two or more distinct web extensions classify as website dump", () => {
  // Distinct extensions count, not files: 3 distinct exts, big files welcome.
  const website = statsFor([
    ["index.html", 150 * 1024],
    ["assets/style.css", 150 * 1024],
    ["assets/app.js", 150 * 1024],
    ["downloads/big-movie.bin", 200 * 1024],
  ]);
  expect(classifyArchive(website)).toBe("website");

  // A single distinct web extension, however many files, is not a website dump.
  const one = statsFor([
    ["index.html", 200 * 1024],
    ["a.html", 200 * 1024],
    ["b.html", 200 * 1024],
  ]);
  expect(classifyArchive(one)).toBeNull();

  // Nested directories count toward distinct extensions.
  const nested = statsFor([
    ["site/pages/home.html", 500],
    ["site/assets/css/main.scss", 500],
    ["site/assets/fonts/inter.woff2", 500],
    ["docs/readme.bin", 500],
  ]);
  expect(classifyArchive(nested)).toBe("website");

  // Case-insensitive extension matching.
  const upper = statsFor([
    ["INDEX.HTML", 500],
    ["STYLE.CSS", 500],
    ["X.JS", 500],
  ]);
  expect(classifyArchive(upper)).toBe("website");
});

test("classifyArchive: extension matching is case-insensitive", () => {
  const upper = statsFor([
    ["INDEX.HTML", 500],
    ["STYLE.CSS", 500],
    ["FONT.WOFF2", 500],
    ["APP.JS", 500],
    ["X.HTML", 500],
  ]);
  expect(classifyArchive(upper)).toBe("website");
  expect(classifyArchive(statsFor([
    ["A.TORRENT", 1000],
    ["B.TORRENT", 1000],
    ["C.TORRENT", 1000],
    ["D.BIN", 200 * 1024],
  ]))).toBe("torrent");
});

test("classifyArchive: >=60% tiny files, with exact 20KB boundary", () => {
  const tiny = statsFor([
    ["a", 100],
    ["b", 100],
    ["c", 100],
    ["d", 100],
    ["e", 100],
    ["f", 100],
    ["g", 100 * 1024],
    ["h", 100 * 1024],
    ["i", 100 * 1024],
    ["j", 100 * 1024],
  ]);
  expect(classifyArchive(tiny)).toBe("tiny");

  // exactly 20KB is not "smaller than 20KB"
  const boundary = statsFor([
    ["a", 20 * 1024], ["b", 20 * 1024], ["c", 20 * 1024], ["d", 20 * 1024], ["e", 20 * 1024],
    ["f", 100 * 1024], ["g", 100 * 1024], ["h", 100 * 1024], ["i", 100 * 1024], ["j", 100 * 1024],
  ]);
  expect(classifyArchive(boundary)).toBeNull();
});

test("parseArchiveListLine parses size+name, rejects dirs and plain names", () => {
  expect(parseArchiveListLine("        5 ./file.txt")).toEqual({ path: "./file.txt", size: 5 });
  expect(parseArchiveListLine("        0 ./dir/")).toBeNull();
  expect(parseArchiveListLine("100 a b.txt")).toEqual({ path: "a b.txt", size: 100 });
  expect(parseArchiveListLine("")).toBeNull();
  expect(parseArchiveListLine("./plain-name.txt")).toBeNull();
});

test("classifyArchive: torrent takes precedence over tiny/website", () => {
  const stats = statsFor([
    ["a.torrent", 100],
    ["b.torrent", 100],
    ["c.torrent", 100],
    ["index.html", 100],
    ["x.js", 100],
  ]);
  expect(classifyArchive(stats)).toBe("torrent");
});

test("isSafeRel rejects backslash traversal and control characters", () => {
  expect(isSafeRel("dir/file.zip")).toBe(true);
  expect(isSafeRel("..\\evil")).toBe(false);
  expect(isSafeRel("dir\\..\\evil")).toBe(false);
  expect(isSafeRel("dir\nwith/newline.zip")).toBe(false);
  expect(isSafeRel("dir\rcarriage.zip")).toBe(false);
  expect(isSafeRel("dir/tab\there.zip")).toBe(false);
});

test("redactArgs redacts a sensitive value even when it starts with a dash", () => {
  const redacted = redactArgs(["rclonex", "archive", "extract", "--archive-password", "-p4ssw0rd", "--size", "10"]);
  expect(redacted.join(" ")).not.toContain("-p4ssw0rd");
  expect(redacted).toContain("***");
  expect(redacted).toContain("--size");
  // inline form still redacted
  expect(redactArgs(["--archive-password=hunter2"])[0]).toBe("--archive-password=***");
  // non-sensitive flags pass through untouched
  expect(redactArgs(["--config", "/app/rclone.conf"])[0]).toBe("--config");
});
