import { test, expect, beforeAll, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rx-queuetoggle-"));
delete process.env.DATABASE_URL;

let app: Hono;
let engineState: typeof import("../src/engine").engineState;

beforeAll(async () => {
  const db = await import("../src/db");
  await db.initDb();
  engineState = (await import("../src/engine")).engineState;
  const dashboard = (await import("../src/routes/dashboard")).dashboard;
  const actions = (await import("../src/routes/actions")).actions;
  app = new Hono();
  app.route("/", dashboard);
  app.route("/", actions);
});

afterEach(() => {
  engineState.running = false;
  engineState.jobs = new Map();
});

function queuedJob(id: number) {
  return {
    id,
    rel: `incoming/archive${id}.zip`,
    order: id - 1,
    status: "queued" as const,
    phase: "",
    command: "",
    stats: null,
    attempt: 0,
    cooldownUntil: 0,
    skipArchive: false,
    skipInspection: false,
    queueSkipped: false,
    groupKey: null,
    finishedAt: "",
  };
}

async function toggle(id: number, skip: boolean): Promise<{ html: string; trigger: string }> {
  const form = new FormData();
  form.set("id", String(id));
  form.set("skip", skip ? "1" : "0");
  const res = await app.request("/run/queue-toggle", { method: "POST", body: form });
  expect(res.status).toBe(200);
  return { html: await res.text(), trigger: res.headers.get("HX-Trigger") ?? "" };
}

test("queue rows show a bare Queue ID and a skip toggle", async () => {
  engineState.jobs = new Map([[7, queuedJob(7)]]);
  const html = await (await app.request("/dashboard/queue?page=1")).text();
  expect(html).toContain('class="queue-id">#7</td>');
  expect(html).not.toContain("Queue ID #7");
  expect(html).toContain('id="queue-skip-7"');
  expect(html).toContain(">Skip</button>");
});

test("the toggle flips the queued flag and the button label", async () => {
  engineState.jobs = new Map([[7, queuedJob(7)]]);
  const skipped = await toggle(7, true);
  expect(engineState.jobs.get(7)!.queueSkipped).toBe(true);
  expect(skipped.html).toContain(">Add</button>");
  expect(skipped.trigger).toContain("Archive skipped for this run.");

  const queue = await (await app.request("/dashboard/queue?page=1")).text();
  expect(queue).toContain(">Add</button>");

  const added = await toggle(7, false);
  expect(engineState.jobs.get(7)!.queueSkipped).toBe(false);
  expect(added.html).toContain(">Skip</button>");
});

test("a skipped archive stays in the queue count", async () => {
  engineState.jobs = new Map([[7, queuedJob(7)]]);
  await toggle(7, true);
  const html = await (await app.request("/dashboard/controls")).text();
  expect(html).toContain("Show Queue (1)");
});
