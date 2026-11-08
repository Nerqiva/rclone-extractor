import { test, expect } from "bun:test";
import { toPgPlaceholders, toPgInsert } from "../src/db/schema";

test("placeholder conversion", () => {
  expect(toPgPlaceholders("SELECT * FROM t WHERE a=? AND b=?")).toBe(
    "SELECT * FROM t WHERE a=$1 AND b=$2",
  );
  expect(toPgPlaceholders("SELECT 1")).toBe("SELECT 1");
});

test("insert or ignore -> on conflict do nothing", () => {
  expect(
    toPgInsert("INSERT OR IGNORE INTO archives(path) VALUES(?)"),
  ).toBe("INSERT INTO archives(path) VALUES(?) ON CONFLICT DO NOTHING");
});

test("insert or replace settings -> upsert", () => {
  expect(
    toPgInsert("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)"),
  ).toBe(
    "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  );
});

test("insert or replace logs -> composite conflict", () => {
  const out = toPgInsert(
    "INSERT OR REPLACE INTO logs(archive_id, kind, rel_path) VALUES(?, 'extract', ?)",
  );
  expect(out).toContain("ON CONFLICT(archive_id, kind) DO UPDATE SET rel_path=excluded.rel_path");
});

test("insert or replace archives -> conflict on path", () => {
  const out = toPgInsert(
    "INSERT OR REPLACE INTO archives(id, path, size, status, error_kind, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
  );
  expect(out).toContain("ON CONFLICT(path) DO UPDATE SET");
});
