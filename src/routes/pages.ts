import { Hono } from "hono";
import { store } from "../db";
import { layout, esc } from "../ui";
import { csrfFor } from "./auth";
import { configForm } from "./actions";
import { encryptionEnabled } from "../crypto";
import { engineState } from "../engine";
import { checkRclone } from "../rclone";
import { tailRendered, LOG_TAIL_LIMIT } from "../log";
import { readErrorRows, renderErrorCards } from "../errorrows";

export const pages = new Hono();

pages.get("/", (c) =>
  c.html(
    layout(
      "Task progress",
      `<div hx-get="/dashboard/fragment" hx-trigger="load, every 1s" hx-swap="innerHTML">
        <p class="muted">Loading…</p>
      </div>
      <div class="controls-dock">
        <div id="controls" hx-get="/dashboard/controls" hx-trigger="load" hx-swap="outerHTML"></div>
      </div>`,
      "dashboard",
      csrfFor(c),
    ),
  ),
);

pages.get("/config", async (c) => {
  const csrf = csrfFor(c);
  const runtime = await checkRclone();
  const runtimeRow = runtime.ok
    ? `<dt>rclone</dt><dd><code>${esc(runtime.detail)}</code><br><span class="muted">${esc(runtime.bin)}</span></dd>`
    : `<dt>rclone</dt><dd><span class="note err">not runnable</span><br><code>${esc(runtime.detail)}</code></dd>`;
  const running = engineState.running;
  const dis = running ? " disabled" : "";
  const backupCls = running ? "card is-disabled" : "card";
  const extra = `<div class="card">
    <h2 class="section-title" style="margin-top:0">Runtime</h2>
    <dl class="detail-grid">${runtimeRow}</dl>
    ${
      runtime.ok
        ? ""
        : `<p class="muted">The extractor cannot run rclone. Install the build matching your CPU architecture (arm64 vs amd64) or set <code>RCLONE_BIN</code>, then redeploy.</p>`
    }
  </div>
  <div class="${backupCls}">
    <h2 class="section-title" style="margin-top:0">Backup</h2>
    <fieldset class="bare-fieldset"${dis}>
    <form id="export-form" method="post" action="/export">
      <input type="hidden" name="csrf_token" value="${esc(csrf ?? "")}">
      <label class="check"><input type="checkbox" name="include_rclone" value="1"> include secrets (rclone.conf, database_url)</label>
      <button class="btn" type="submit" data-loading-label="Exporting…"><span class="spinner" aria-hidden="true"></span><span class="btn-label">Export JSON</span></button>
    </form>
    <form id="import-form" style="margin-top:14px" method="post" action="/import" enctype="multipart/form-data">
      <input type="hidden" name="csrf_token" value="${esc(csrf ?? "")}">
      <label class="field"><span>Import backup (.json)</span><input type="file" name="archive" accept=".json,application/json"></label>
      <button class="btn danger" type="submit" data-loading-label="Importing…"><span class="spinner" aria-hidden="true"></span><span class="btn-label">Import (replaces data)</span></button>
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
    ${running ? `<p class="muted">Task running — options are disabled.</p>` : ""}
    <div class="btn-row">
      <button class="btn" hx-post="/maintenance/queues" hx-target="#maintenance-result" hx-swap="innerHTML" data-confirm="Clear the queue?|Clear queues"><span class="spinner" aria-hidden="true"></span>Clear queues</button>
      <button class="btn" hx-post="/maintenance/runs" hx-target="#maintenance-result" hx-swap="innerHTML" data-confirm="Clear history (queue, run count and caches)?|Clear History"${dis}><span class="spinner" aria-hidden="true"></span>Clear History</button>
      <button class="btn" hx-post="/maintenance/logs" hx-target="#maintenance-result" hx-swap="innerHTML" data-confirm="Clear logs and errors?|Clear logs"${dis}><span class="spinner" aria-hidden="true"></span>Clear logs</button>
      <button class="btn" hx-post="/maintenance/tmp-purge" hx-target="#tmp-purge-result" hx-swap="innerHTML" data-confirm="Clear the tmp directory?|Clear tmp directory"${dis}><span class="spinner" aria-hidden="true"></span>Clear tmp directory</button>
      <button class="btn danger" hx-post="/maintenance/all" hx-target="#maintenance-result" hx-swap="innerHTML" data-confirm="Clear everything (queue, history, logs, errors, tmp directory)?|Clear everything"${dis}><span class="spinner" aria-hidden="true"></span>Clear everything</button>
    </div>
    <div id="tmp-purge-result"></div>
    <div id="maintenance-result"></div>
  </div>
  <script>
  (function () {
    var toast = function (message, kind) { window.appToast(message, kind); };

    function setLoading(btn, loading) {
      if (!btn) return;
      btn.disabled = loading;
      btn.classList.toggle("is-loading", loading);
      var label = btn.querySelector(".btn-label");
      if (!label) return;
      if (!btn.dataset.idleLabel) btn.dataset.idleLabel = label.textContent;
      label.textContent = loading
        ? (btn.dataset.loadingLabel || "Working…")
        : btn.dataset.idleLabel;
    }

    document.addEventListener("click", function (event) {
      var edit = event.target.closest("[data-edit]");
      if (edit) {
        var setting = edit.closest(".setting");
        if (setting) {
          setting.classList.add("editing");
          var focusable = setting.querySelector("input, textarea, select");
          if (focusable) focusable.focus();
        }
        return;
      }
      var cancel = event.target.closest("[data-cancel]");
      if (cancel) {
        var editing = cancel.closest(".setting");
        if (editing) editing.classList.remove("editing");
      }
    });

    var exportForm = document.getElementById("export-form");
    if (exportForm) {
      exportForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (exportForm.include_rclone && exportForm.include_rclone.checked &&
            !window.confirm("The export will contain unencrypted secrets (rclone.conf, database_url). Continue?")) {
          return;
        }
        var btn = exportForm.querySelector('button[type="submit"]');
        setLoading(btn, true);
        try {
          var res = await fetch(exportForm.action, {
            method: "POST",
            body: new FormData(exportForm),
          });
          var contentType = res.headers.get("content-type") || "";
          if (!res.ok || res.redirected || contentType.indexOf("application/json") === -1) {
            throw new Error("export failed (HTTP " + res.status + ")");
          }
          var disposition = res.headers.get("content-disposition") || "";
          var match = /filename="?([^";]+)"?/.exec(disposition);
          var filename = match ? match[1] : "export-" + Date.now() + ".json";
          var blob = await res.blob();
          var url = URL.createObjectURL(blob);
          var link = document.createElement("a");
          link.href = url;
          link.download = filename;
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          toast("Export downloaded.", "ok");
        } catch (err) {
          toast("Export failed: " + (err && err.message ? err.message : String(err)), "err");
        } finally {
          setLoading(btn, false);
        }
      });
    }

    var importForm = document.getElementById("import-form");
    if (importForm) {
      importForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        var btn = importForm.querySelector('button[type="submit"]');
        var fileInput = importForm.querySelector('input[type="file"]');
        if (fileInput && (!fileInput.files || fileInput.files.length === 0)) {
          toast("Choose a backup .json file first.", "err");
          return;
        }
        if (!window.confirm("Importing a backup overwrites matching rows in the current database. Continue?")) {
          return;
        }
        setLoading(btn, true);
        try {
          var res = await fetch(importForm.action, {
            method: "POST",
            body: new FormData(importForm),
          });
          var data = await res.json().catch(function () { return null; });
          if (!data) throw new Error("import failed (HTTP " + res.status + ")");
          if (!res.ok || !data.ok) throw new Error(data.message || "import failed");
          toast(data.message || "Import complete.", "ok");
          importForm.reset();
        } catch (err) {
          toast("Import failed: " + (err && err.message ? err.message : String(err)), "err");
        } finally {
          setLoading(btn, false);
        }
      });
    }
  })();
  </script>`;
  return c.html(layout("Configuration", (await configForm()) + extra, "config", csrf));
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
  }>(
    "SELECT id, started_at, finished_at, total, done, failed, skipped, interrupted FROM runs ORDER BY id DESC LIMIT 50",
  );

  if (runs.length === 0) {
    return c.html(
      layout(
        "Logs",
        `<div class="card"><p class="muted">No runs yet. Start a task from the Progress page.</p></div>`,
        "logs",
        csrfFor(c),
      ),
    );
  }

  const running = engineState.running && engineState.runId > 0;
  const asked = Number(c.req.query("run") ?? "");
  let selectedId = running
    ? engineState.runId
    : Number.isFinite(asked) && asked > 0
      ? asked
      : Number(runs[0]?.id ?? 0);
  if (!runs.some((r) => Number(r.id) === selectedId)) {
    selectedId = running ? engineState.runId : Number(runs[0]?.id ?? 0);
  }
  if (!runs.some((r) => Number(r.id) === selectedId)) {
    selectedId = Number(runs[0]?.id ?? 0);
  }

  const kind = c.req.query("kind") === "errors" ? "errors" : "main";
  const selected = runs.find((r) => Number(r.id) === selectedId) ?? runs[0];
  const isLive = running && Number(selected.id) === engineState.runId;

  const { entries, lastId } = await tailRendered(
    { scope: "run", refId: Number(selected.id), kind },
    LOG_TAIL_LIMIT,
  );
  const hasLog = lastId > 0;
  const showLog = isLive || hasLog;

  const options = runs
    .map((r) => {
      const dur = r.finished_at
        ? Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000)
        : 0;
      const durStr = dur > 0 ? `${Math.floor(dur / 60)}m ${dur % 60}s` : "…";
      return `<option value="${r.id}"${Number(r.id) === selectedId ? " selected" : ""}>Run #${r.id} · ${esc(r.started_at).slice(11, 16)} · ${durStr} · ${r.done} done</option>`;
    })
    .join("");

  const picker = running
    ? `<div class="session-static"><span class="pill warn">live</span> <span class="muted">Old sessions are available when this task finishes.</span></div>`
    : `<form class="session-picker" method="get" action="/logs">
        <label class="field">
          <span>Session</span>
          <select name="run">${options}</select>
        </label>
        <input type="hidden" name="kind" value="${kind}">
        <button class="btn small" type="submit">View</button>
      </form>`;

  const tabs = `<div class="log-tabs">
    <a class="log-tab${kind === "main" ? " active" : ""}" href="/logs?run=${selectedId}&amp;kind=main">Run log</a>
    <a class="log-tab${kind === "errors" ? " active" : ""}" href="/logs?run=${selectedId}&amp;kind=errors">Errors</a>
  </div>`;

  const interrupted = Number(selected.interrupted ?? 0) === 1;
  const statusPill = isLive
    ? `<span class="pill warn" id="livePill">Live</span>`
    : `<span class="pill ${selected.finished_at && !interrupted ? "ok" : "warn"}">${
        interrupted ? "Interrupted" : selected.finished_at ? "Finished" : "Incomplete"
      }</span>`;

  const dur = selected.finished_at
    ? Math.round((new Date(selected.finished_at).getTime() - new Date(selected.started_at).getTime()) / 1000)
    : 0;
  const durStr = dur > 0 ? `${Math.floor(dur / 60)}m ${dur % 60}s` : "running";

  const summary = `<div class="session-summary">
    ${statusPill}
    <span>Run #${selected.id} · ${esc(selected.started_at).slice(11, 16)} · ${durStr}</span>
    <span class="summary-counts">
      <span class="muted">done ${selected.done}</span> ·
      <a href="/errors" class="muted">failed ${selected.failed}</a> ·
      <span class="muted">skipped ${selected.skipped}</span>
    </span>
    ${isLive ? `<span class="muted live-note" id="liveNote">polling 2s</span>` : ""}
  </div>`;

  const downloadHref = `/download/run/${selected.id}?kind=${kind}`;
  const copyToolbar = `<div class="log-actions" role="toolbar" aria-label="Log actions">
      <div class="log-filters">
        <button class="btn small filter-chip active" data-filter="all">All</button>
        <button class="btn small filter-chip" data-filter="warnerr">Warnings &amp; Errors</button>
      </div>
      <span class="log-actions-right">
        <button class="btn small" type="button" data-copy-url="${esc(downloadHref)}">Copy all</button>
        <a class="btn small ghost" href="${esc(downloadHref)}">Download ${kind === "errors" ? "errors" : "log"}</a>
      </span>
    </div>`;

  const entriesHtml = entries.map((e) => e.html).join("");
  const logBlock = showLog
    ? `<div class="log-viewer" id="logViewer" data-run="${selected.id}" data-kind="${kind}" data-live="${
        isLive ? "1" : "0"
      }" data-last-id="${lastId}">${entriesHtml}</div>`
    : `<div class="empty-state"><p class="muted">${
        kind === "errors" ? "No errors in this session." : "No log lines yet."
      }</p></div>`;

  const body = `<div class="log-toolbar">
      ${picker}
      ${tabs}
    </div>
    ${summary}
    ${showLog ? copyToolbar : ""}
    ${logBlock}
    <script src="/public/copy.js" defer></script>`;
  return c.html(layout("Logs", body, "logs", csrfFor(c)));
});

pages.get("/errors", async (c) => {
  const running = engineState.running && engineState.runId > 0;
  const rows = await readErrorRows(store);
  const body = `<div class="log-actions" role="toolbar" aria-label="Error actions">
      ${running ? `<span class="pill warn" id="livePill">live</span>` : ""}
      <button class="btn small" type="button" data-copy-table="#errorCards">Copy all errors</button>
    </div>
    <div id="errorCards" data-live="${running ? "1" : "0"}">${renderErrorCards(rows)}</div>
    <script src="/public/copy.js" defer></script>`;
  return c.html(layout("Errors", body, "errors", csrfFor(c)));
});
