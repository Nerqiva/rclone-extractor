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
import { parseArchiveListLine } from "../src/rclone";

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

test("classifyArchive: website markers and >=20% small files", () => {
  const website = statsFor([
    ["index.html", 500],
    ["a.css", 500],
    ["b.js", 500],
    ["c.jpg", 150 * 1024],
  ]);
  expect(classifyArchive(website)).toBe("website");

  // marker present but <20% small files
  const big = statsFor([
    ["index.html", 500],
    ["a.jpg", 200 * 1024],
    ["b.jpg", 200 * 1024],
    ["c.jpg", 200 * 1024],
    ["d.jpg", 200 * 1024],
    ["e.jpg", 200 * 1024],
    ["f.jpg", 200 * 1024],
  ]);
  expect(classifyArchive(big)).toBeNull();
});

test("classifyArchive: extension and marker matching is case-insensitive", () => {
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
