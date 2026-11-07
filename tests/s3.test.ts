import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db:
  | typeof import("../src/db")
  | null = null;
let runEngine: typeof import("../src/engine").runEngine;
let engineState: typeof import("../src/engine").engineState;
let getSetting: typeof import("../src/db").getSetting;
let setSetting: typeof import("../src/db").setSetting;
let readAll: typeof import("../src/log").readAll;

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "rx-s3-"));
  process.env.DATA_DIR = base;
  delete process.env.DATABASE_URL;

  const binDir = join(base, "bin");
  mkdirSync(binDir, { recursive: true });
  const scanRoot = join(base, "scan");
  mkdirSync(scanRoot, { recursive: true });

  const script = `#!/bin/sh
if [ "$1" = "lsf" ]; then
  echo "./a/b.zip;100000"
  echo "./a/c.zip;100000"
  echo "./torrent.zip;100000"
  echo "./website.zip;100000"
  echo "./tiny.zip;100000"
  echo "./empty.zip;100000"
  echo "./corrupt.zip;100000"
  echo "./trash/old.zip;100000"
  exit 0
fi
if [ "$1" = "archive" ] && [ "$2" = "list" ]; then
  case "$*" in
    *torrent.zip*)
      printf '100 ./a.torrent\\n100 ./b.torrent\\n100 ./c.torrent\\n100 ./d.torrent\\n30720 ./big.bin\\n'
      exit 0 ;;
    *website.zip*)
      printf '100 ./index.html\\n100 ./style.css\\n100 ./app.js\\n30000 ./a.bin\\n30000 ./b.bin\\n30000 ./c.bin\\n30000 ./d.bin\\n'
      exit 0 ;;
    *tiny.zip*)
      printf '100 ./a\\n100 ./b\\n100 ./c\\n100 ./d\\n100 ./e\\n100 ./f\\n40000 ./g\\n40000 ./h\\n40000 ./i\\n40000 ./j\\n'
      exit 0 ;;
    *empty.zip*) exit 0 ;;
    *corrupt.zip*) echo 'not an archive' 1>&2; exit 1 ;;
    *) printf '40000 ./big.bin\\n'; exit 0 ;;
  esac
fi
if [ "$1" = "archive" ] && [ "$2" = "extract" ]; then
  case "$3" in
    *b.zip*) exit 0 ;;
    *c.zip*) echo "password required" 1>&2; exit 1 ;;
  esac
  exit 0
fi
exit 0
`;
  const binPath = join(binDir, "rclone");
  writeFileSync(binPath, script);
  chmodSync(binPath, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH}`;

  db = await import("../src/db");
  await db.initDb();
  getSetting = db.getSetting;
  setSetting = db.setSetting;
  await setSetting("scan_root", scanRoot);
  await setSetting("remote_flags", "");

  const eng = await import("../src/engine");
  runEngine = eng.runEngine;
  engineState = eng.engineState;
  readAll = (await import("../src/log")).readAll;

  await runEngine();
});

test("engine processes archives", async () => {
  const rows = await db!.store.query<{
    path: string;
    status: string;
    error_kind: string | null;
  }>("SELECT path, status, error_kind FROM archives ORDER BY path");
  const done = rows.filter((r) => r.status === "done");
  const skipped = rows.filter((r) => r.status === "skipped");
  expect(done.length).toBe(1);
  expect(done[0].path).toBe("a/b.zip");
  expect(skipped.length).toBe(6);
  const kindByPath = new Map(skipped.map((r) => [r.path, r.error_kind]));
  expect(kindByPath.get("a/c.zip")).toBe("password");
  expect(kindByPath.get("torrent.zip")).toBe("torrent");
  expect(kindByPath.get("website.zip")).toBe("website");
  expect(kindByPath.get("tiny.zip")).toBe("tiny");
  expect(kindByPath.get("empty.zip")).toBe("empty");
  expect(kindByPath.get("corrupt.zip")).toBe("unreadable");
  // Archives under the trash subdir are never queued
  expect(rows.some((r) => r.path.startsWith("trash/"))).toBe(false);
  expect(engineState.done).toBe(1);
  expect(engineState.skipped).toBe(6);
  expect(await getSetting("scan_root")).toBeTruthy();
});

test("skipped archives are not extracted", async () => {
  const skipped = await db!.store.query<{ id: number; path: string }>(
    // c.zip fails during extraction (password); the content filters must not
    // invoke extract at all.
    "SELECT id, path FROM archives WHERE status='skipped' AND error_kind <> 'password'",
  );
  for (const row of skipped) {
    const lines = await readAll({
      scope: "archive",
      refId: Number(row.id),
      kind: "extract",
    });
    expect(
      lines.some((line) => line.includes("$ rclone archive extract")),
      `${row.path} should not have been extracted`,
    ).toBe(false);
  }
});

test("run log and error log include the active rclone command", async () => {
  const main = await readAll({
    scope: "run",
    refId: engineState.runId,
    kind: "main",
  });
  expect(main.some((line) => line.includes("$ rclone lsf"))).toBe(true);

  const errors = await readAll({
    scope: "run",
    refId: engineState.runId,
    kind: "errors",
  });
  const commandLine = errors.find((line) =>
    line.includes("$ rclone archive extract"),
  );
  expect(commandLine).toBeDefined();
  expect(commandLine).toContain("c.zip");
});

test("per-archive log records the command that ran", async () => {
  const row = await db!.store.get1<{ id: number }>(
    "SELECT id FROM archives WHERE path='a/c.zip'",
  );
  expect(row).toBeDefined();
  const lines = await readAll({
    scope: "archive",
    refId: Number(row!.id),
    kind: "extract",
  });
  expect(lines.some((line) => line.includes("$ rclone archive extract"))).toBe(
    true,
  );
});

test("promote command excludes the tmp workspace from the destination", async () => {
  const row = await db!.store.get1<{ id: number }>(
    "SELECT id FROM archives WHERE path='a/b.zip'",
  );
  expect(row).toBeDefined();
  const lines = await readAll({
    scope: "archive",
    refId: Number(row!.id),
    kind: "extract",
  });
  expect(
    lines.some(
      (line) =>
        line.includes("$ rclone move") &&
        line.includes("--exclude") &&
        line.includes("/.rclone-extractor-tmp/**"),
    ),
  ).toBe(true);
});

test("done paths are re-queued on a later non-dry run", async () => {
  await setSetting("dry_run", "0");
  await runEngine();
  expect(engineState.total).toBe(1);
  const row = await db!.store.get1<{ status: string }>(
    "SELECT status FROM archives WHERE path='a/b.zip'",
  );
  expect(row?.status).toBe("done");
});

test("dry-run does not re-queue done paths", async () => {
  await setSetting("dry_run", "1");
  await runEngine();
  expect(engineState.total).toBe(0);
  await setSetting("dry_run", "0");
});

test("pre-existing queued rows in the trash subdir are not selected", async () => {
  await db!.store.run(
    "INSERT OR REPLACE INTO archives(path, size, status, created_at, updated_at) VALUES('trash/legacy.zip', 1, 'queued', 't', 't')",
  );
  await setSetting("dry_run", "0");
  await runEngine();
  // Only a/b.zip (done, re-queued) counts; the trash row stays queued and is ignored.
  expect(engineState.total).toBe(1);
  const row = await db!.store.get1<{ status: string }>(
    "SELECT status FROM archives WHERE path='trash/legacy.zip'",
  );
  expect(row?.status).toBe("queued");
  await db!.store.run("DELETE FROM archives WHERE path='trash/legacy.zip'");
});

test("resume recovers stale extracting rows", async () => {
  await db!.store.run(
    "INSERT OR REPLACE INTO archives(path, size, status, created_at, updated_at) VALUES('stale.zip', 5, 'extracting', 't', 't')",
  );
  const eng = await import("../src/engine");
  const recovered = await eng.recoverStale();
  expect(recovered).toBeGreaterThanOrEqual(1);
  const row = await db!.store.get1<{ status: string }>(
    "SELECT status FROM archives WHERE path='stale.zip'",
  );
  expect(row?.status).toBe("queued");
});
