import { Hono } from "hono";
import { store, getSetting } from "../db";
import { layout, esc, fmtDisplayTime, info, asset, APP_VERSION } from "../ui";
import { emptyState } from "../cardui";
import { BOOT_AT } from "../config";
import { csrfFor } from "./auth";
import { configForm, controlsFragment } from "../views";
import { resolveOutcome } from "../runs";
import { encryptionEnabled } from "../crypto";
import { engineState } from "../engine";
import { liveArchiveStates } from "../live";
import { checkRclone, checkRclonex, pendingRcloneConfNotice } from "../rclone";
import { tailRendered, LOG_TAIL_LIMIT } from "../log";
import { readErrorRows, renderFailureCards, renderSkipCards } from "../errorrows";
import { readPasswordRows, renderPasswordList } from "../passwordrows";
import { readArchiveLogRows, renderArchiveLogRows } from "../archiverows";
import { progressPanel } from "./dashboard";

export const pages = new Hono();

pages.get("/", async (c) => {
  const confNotice = pendingRcloneConfNotice();
  const noticeScript = confNotice
    ? `<span data-app-toast="${esc(confNotice)}" data-toast-kind="err" hidden></span>`
    : "";
  const [panel, controls] = await Promise.all([
    progressPanel(),
    Promise.resolve(controlsFragment()),
  ]);
  return c.html(
    layout(
      "Progress",
      `<div id="dashboard-panel" hx-get="/dashboard/fragment" hx-trigger="every 1s" hx-swap="morphdom">${panel}</div>
      <div class="controls-dock">
        ${controls}
        <div id="queuePanel" class="queue-panel" hidden>
          <h2 class="section-title">Queue</h2>
          <div id="queuePanelBody"></div>
        </div>
      </div>${noticeScript}`,
      "dashboard",
      csrfFor(c),
      "Start, stop and watch the current task.",
    ),
  );
});

pages.get("/config", async (c) => {
  const csrf = csrfFor(c);
  const runtime = await checkRclone();
  const runtimeRow = runtime.ok
    ? `<dt>rclone</dt><dd><code>${esc(runtime.detail)}</code><br><span class="muted">${esc(runtime.bin)}</span></dd>`
    : `<dt>rclone</dt><dd><span class="note err">not runnable</span><br><code>${esc(runtime.detail)}</code></dd>`;
  const rclonexRuntime = await checkRclonex();
  const rclonexRow = rclonexRuntime.ok
    ? `<dt>rclonex</dt><dd><code>${esc(rclonexRuntime.detail)}</code><br><span class="muted">${esc(rclonexRuntime.bin)}</span></dd>`
    : `<dt>rclonex</dt><dd><span class="note err">not runnable</span><br><code>${esc(rclonexRuntime.detail)}</code></dd>`;
  const versionRow = `<dt>App version</dt><dd><code>${esc(APP_VERSION)}</code></dd>`;
  const bootRow = `<dt>Booted at</dt><dd><code>${esc(fmtDisplayTime(BOOT_AT.toISOString(), true))}</code></dd>`;
  const running = engineState.running;
  const dis = running ? " disabled" : "";
  const backupCls = running ? "card is-disabled" : "card";
  const extra = `<div class="card">
    <h2 class="section-title" style="margin-top:0">Runtime</h2>
    <dl class="detail-grid">${versionRow}${bootRow}${runtimeRow}${rclonexRow}</dl>
    ${
      runtime.ok
        ? ""
        : `<p class="muted">rclone not runnable. See deploy logs (<code>RCLONE_BIN</code>, arch match).</p>`
    }
    ${
      rclonexRuntime && !rclonexRuntime.ok
        ? `<p class="muted">RcloneX is enabled but not runnable. All extraction will fail. Install the newest rclonex release or set <code>RCLONEX_BIN</code>.</p>`
        : ""
    }
  </div>
  <div class="${backupCls}">
    <h2 class="section-title" style="margin-top:0">Backup</h2>
    <fieldset class="bare-fieldset"${dis}>
    <form id="export-form" method="post" action="/export">
      <input type="hidden" name="csrf_token" value="${esc(csrf ?? "")}">
      <label class="check"><input type="checkbox" name="include_rclone" value="1"> include secrets (rclone.conf, database_url, archive password) ${info("Exports contain unencrypted secrets. Only tick it if you store backups somewhere safe.", "include secrets")}</label>
      <button class="btn" type="submit" data-loading-label="Exporting…"><span class="spinner" aria-hidden="true"></span><span class="btn-label">Export JSON</span></button>
    </form>
    <form id="import-form" style="margin-top:14px" method="post" action="/import" enctype="multipart/form-data">
      <input type="hidden" name="csrf_token" value="${esc(csrf ?? "")}">
      <label class="field"><span>Import backup (.json)</span><input type="file" name="archive" accept=".json,application/json"></label>
      <button class="btn danger" type="submit" data-loading-label="Importing…"><span class="spinner" aria-hidden="true"></span><span class="btn-label">Import (replaces data)</span></button>${info("Overwrites matching rows in the current database. Settings not in the file are kept.", "Import")}
    </form>
    </fieldset>
    ${
      encryptionEnabled()
        ? ""
        : `<p class="muted">Set the <code>SECRET_KEY</code> env var to encrypt stored secrets.</p>`
    }
  </div>
  <div class="card">
    <h2 class="section-title" style="margin-top:0">Maintenance</h2>
    ${running ? `<p class="muted">Task running. Destructive actions are disabled. The settings form above stays editable; changes apply from the next run.</p>` : ""}
    <div class="btn-row">
      <span class="maint-btn"><button class="btn" hx-post="/maintenance/queues" hx-target="#maintenance-result" hx-swap="innerHTML" data-confirm="Clear the queue?|Clear queues"><span class="spinner" aria-hidden="true"></span>Clear queues</button>${info("Deletes queued archives (and their logs). A running engine skips the deleted rows; run count and history are kept.", "Clear queues")}</span>
      <span class="maint-btn"><button class="btn" hx-post="/maintenance/logs" hx-target="#maintenance-result" hx-swap="innerHTML" data-confirm="Clear logs and errors?|Clear logs"${dis}><span class="spinner" aria-hidden="true"></span>Clear logs</button>${info("Wipes log lines and error flags only. Runs and archives are kept.", "Clear logs")}</span>
      <span class="maint-btn"><button class="btn" hx-post="/maintenance/tmp-purge" hx-target="#tmp-purge-result" hx-swap="innerHTML" data-confirm="Clear the tmp directory?|Clear tmp directory"${dis}><span class="spinner" aria-hidden="true"></span>Clear tmp directory</button>${info("Purges stale app-owned run_* directories.", "Clear tmp directory")}</span>
      <span class="maint-btn"><button class="btn danger" hx-post="/maintenance/all" hx-target="#maintenance-result" hx-swap="innerHTML" data-confirm="Clear everything (queue, history, logs, errors, tmp directory)?|Clear everything"${dis}><span class="spinner" aria-hidden="true"></span>Clear everything</button>${info("Queue, history, logs, errors and the tmp directory. Next run starts from #1.", "Clear everything")}</span>
    </div>
    <div id="tmp-purge-result"></div>
    <div id="maintenance-result"></div>
  </div>`;
  return c.html(layout("Configuration", (await configForm()) + extra, "config", csrf, "Settings, secrets, backup and maintenance."));
});

pages.get("/logs", async (c) => {
  const runs = await store.query<{
    id: number;
    started_at: string;
    finished_at: string | null;
    total: number;
    done: number;
    failed: number;
    skipped: number;
    interrupted: number | null;
    interrupted_reason: string | null;
    outcome: string | null;
    error_kind: string | null;
  }>(
    "SELECT id, started_at, finished_at, total, done, failed, skipped, interrupted, interrupted_reason, outcome, error_kind FROM runs ORDER BY id DESC LIMIT 50",
  );

  const isArchivesTab = c.req.query("tab") === "archives";

  const running = engineState.running && engineState.runId > 0;
  const asked = Number(c.req.query("run") ?? "");
  let selectedId = running
    ? engineState.runId
    : Number.isFinite(asked) && asked > 0
      ? asked
      : Number(runs[0]?.id ?? 0);
  if (!runs.some((r) => Number(r.id) === selectedId)) {
    selectedId = Number(runs[0]?.id ?? 0);
  }

  const tabs = `<div class="log-tabs">
    <a class="log-tab${isArchivesTab ? "" : " active"}" href="/logs?run=${selectedId}&amp;tab=main">Run log</a>
    <a class="log-tab${isArchivesTab ? " active" : ""}" href="/logs?run=${selectedId}&amp;tab=archives">Archives</a>
  </div>`;

  if (runs.length === 0) {
    return c.html(
      layout(
        "Logs",
        `<div class="log-toolbar">${tabs}</div>
         <div class="card"><p class="muted">No runs yet. Start a task from the Progress page.</p></div>`,
        "logs",
        csrfFor(c),
        "Raw output of each run.",
      ),
    );
  }

  const selected = runs.find((r) => Number(r.id) === selectedId) ?? runs[0];
  const isLive = running && Number(selected.id) === engineState.runId;

  const { entries, lastId } = isArchivesTab
    ? { entries: [], lastId: 0 }
    : await tailRendered(
        { scope: "run", refId: Number(selected.id), kind: "main" },
        LOG_TAIL_LIMIT,
      );
  const archiveRows = isArchivesTab
    ? await readArchiveLogRows(Number(selected.id))
    : [];
  const liveArchiveJobs = liveArchiveStates(Number(selected.id), isArchivesTab && isLive);
  const hasLog = lastId > 0;
  const showLog = isLive || hasLog;

  const runSecs = (r: { started_at: string; finished_at: string | null }): number =>
    r.finished_at
      ? Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000)
      : 0;
  const durLabel = (secs: number, fallback: string): string =>
    secs > 0 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : fallback;

  const options = runs
    .map((r) => {
      const durStr = durLabel(runSecs(r), "…");
      return `<option value="${r.id}"${Number(r.id) === selectedId ? " selected" : ""}>Run #${r.id} · ${esc(fmtDisplayTime(r.started_at, true))} · ${durStr} · ${r.done} done</option>`;
    })
    .join("");

  const picker = running
    ? `<div class="session-static"><span class="pill warn">live</span> <span class="muted">Old sessions are available when this task finishes.</span></div>`
    : `<form class="session-picker" method="get" action="/logs">
        <label class="field">
          <span>Session</span>
          <select name="run">${options}</select>
        </label>
        <input type="hidden" name="tab" value="${isArchivesTab ? "archives" : "main"}">
        <button class="btn small" type="submit">View</button>
      </form>`;

  const outcome = resolveOutcome(selected);
  const reason = selected.interrupted_reason ?? "";
  const outcomeTime = selected.finished_at
    ? ` · ${fmtDisplayTime(String(selected.finished_at), true)}`
    : "";
  const badOutcome =
    outcome === "interrupted" || outcome === "killed" || outcome === "error";
  const codeSuffix = selected.error_kind && selected.error_kind !== outcome
    ? ` (${esc(selected.error_kind)})`
    : "";
  const outcomeDetail = badOutcome
    ? `${outcome[0].toUpperCase() + outcome.slice(1)}${codeSuffix}${
        reason ? `. ${esc(reason)}` : ""
      }${outcomeTime}`
    : "";
  const statusPill = isLive
    ? `<span class="pill warn" id="livePill">Live</span>`
    : outcome === "interrupted"
      ? `<span class="pill warn">Interrupted</span>`
      : outcome === "killed"
        ? `<span class="pill err">Killed</span>`
        : outcome === "error"
          ? `<span class="pill err">Error</span>`
          : `<span class="pill ${selected.finished_at ? "ok" : "warn"}">${
              selected.finished_at ? "Finished" : "Incomplete"
            }</span>`;

  const durStr = durLabel(runSecs(selected), "running");

  const summary = `<div class="session-summary">
    ${statusPill}
    <span>Run #${selected.id} · ${esc(fmtDisplayTime(selected.started_at, true))} · ${durStr}</span>
    <span class="summary-counts">
      <span class="muted">done ${selected.done}</span> ·
      <a href="/errors" class="muted">failed ${selected.failed}</a> ·
      <span class="muted">skipped ${selected.skipped}</span>
    </span>
    ${isLive ? `<span class="muted live-note" id="liveNote">polling 2s</span>` : ""}
    ${outcomeDetail ? `<span class="warn-line">${outcomeDetail}</span>` : ""}
  </div>`;

  const downloadHref = `/download/run/${selected.id}?kind=main`;
  const copyToolbar = isArchivesTab
    ? `<div class="log-actions" role="toolbar" aria-label="Archive log actions">
      <span class="log-actions-right">
        <a class="btn small ghost" href="/download/run/${selected.id}/all">Download all logs</a>
      </span>
    </div>`
    : `<div class="log-actions" role="toolbar" aria-label="Log actions">
      ${isLive ? `<button class="btn small" type="button" data-live-toggle="log" aria-pressed="true" title="Toggle live preview">Live preview</button>` : ""}
      <span class="log-actions-right">
        <button class="btn small" type="button" data-copy-url="${esc(downloadHref)}">Copy all</button>
        <a class="btn small ghost" href="${esc(downloadHref)}">Download log</a>
      </span>
    </div>`;

  const entriesHtml = entries.map((e) => e.html).join("");
  const pollAttr =
    isLive && isArchivesTab
      ? ` hx-get="/logs/archives-fragment?run=${selected.id}" hx-trigger="every 2s" hx-swap="morphdom"`
      : "";
  const logBlock = isArchivesTab
    ? `<div id="ar-list"${pollAttr}>${renderArchiveLogRows(archiveRows ?? [], liveArchiveJobs)}</div>`
    : showLog
      ? `<div class="log-viewer" id="logViewer" data-run="${selected.id}" data-live="${
          isLive ? "1" : "0"
        }" data-last-id="${lastId}">${entriesHtml}</div>`
      : emptyState(`<p class="muted">No log lines yet.</p>`);

  const body = `<div class="log-toolbar">
      ${picker}
      ${tabs}
    </div>
    ${summary}
    ${showLog || isArchivesTab ? copyToolbar : ""}
    ${logBlock}
    <script src="${asset("copy.js")}" defer></script>`;
  return c.html(layout("Logs", body, "logs", csrfFor(c), "Raw output of each run, newest session first."));
});


pages.get("/errors", async (c) => {
  const running = engineState.running && engineState.runId > 0;
  const [rows, pwRows] = await Promise.all([readErrorRows(store), readPasswordRows()]);
  const body = `<h2 class="section-title" style="margin-top:0">Failed archives ${info("Archives that failed in this run, newest first. Each card shows the failed stage; Log view opens the per-archive output with stage markers.", "Failed archives")}</h2>
    <div class="log-actions" role="toolbar" aria-label="Error actions">
      ${running ? `<span class="pill warn" id="livePill">live</span>` : ""}
      ${running ? `<button class="btn small" type="button" data-live-toggle="errors" aria-pressed="true" title="Toggle live preview">Live preview</button>` : ""}
      <button class="btn small" type="button" data-copy-table="#errorCards">Copy all errors</button>
    </div>
    <div id="errorCards" data-live="${running ? "1" : "0"}">${renderFailureCards(rows)}</div>
    <h2 class="section-title">Skipped archives ${info("Archives skipped by the built-in rules and by password detection: password protected, website dump, torrent collection, tiny or unreadable. Delete moves the file to the trash folder; Restore returns it to the queue.", "Skipped archives")}</h2>
    ${renderSkipCards(rows)}
    ${renderPasswordList(pwRows)}
    <script src="${asset("copy.js")}" defer></script>`;
  return c.html(layout("Errors", body, "errors", csrfFor(c), "Archives that need attention: failures and password-protected files."));
});
