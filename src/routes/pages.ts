import { Hono } from "hono";
import { store, getSetting } from "../db";
import { layout, esc, fmtDisplayTime, info } from "../ui";
import { csrfFor } from "./auth";
import { configForm } from "../views";
import { resolveOutcome } from "../runs";
import { encryptionEnabled } from "../crypto";
import { engineState } from "../engine";
import { checkRclone, checkRclonex } from "../rclone";
import { tailRendered, LOG_TAIL_LIMIT } from "../log";
import { readErrorRows, renderErrorCards } from "../errorrows";
import { readPasswordRows, renderPasswordList } from "../passwordrows";

export const pages = new Hono();

pages.get("/", (c) =>
  c.html(
    layout(
      "Progress",
      `<div hx-get="/dashboard/fragment" hx-trigger="load, every 1s" hx-swap="innerHTML">
        <p class="muted">Loading…</p>
      </div>
      <div class="controls-dock">
        <div id="controls" hx-get="/dashboard/controls" hx-trigger="load" hx-swap="outerHTML"></div>
      </div>`,
      "dashboard",
      csrfFor(c),
      "Start, stop and watch the current task.",
    ),
  ),
);

pages.get("/config", async (c) => {
  const csrf = csrfFor(c);
  const runtime = await checkRclone();
  const runtimeRow = runtime.ok
    ? `<dt>rclone</dt><dd><code>${esc(runtime.detail)}</code><br><span class="muted">${esc(runtime.bin)}</span></dd>`
    : `<dt>rclone</dt><dd><span class="note err">not runnable</span><br><code>${esc(runtime.detail)}</code></dd>`;
  const rclonexEnabled = (await getSetting("rclonex", "0")) === "1";
  const rclonexRuntime = rclonexEnabled ? await checkRclonex() : null;
  const rclonexRow = rclonexRuntime
    ? rclonexRuntime.ok
      ? `<dt>rclonex</dt><dd><code>${esc(rclonexRuntime.detail)}</code><br><span class="muted">${esc(rclonexRuntime.bin)}</span></dd>`
      : `<dt>rclonex</dt><dd><span class="note err">not runnable</span><br><code>${esc(rclonexRuntime.detail)}</code></dd>`
    : "";
  const running = engineState.running;
  const dis = running ? " disabled" : "";
  const backupCls = running ? "card is-disabled" : "card";
  const extra = `<div class="card">
    <h2 class="section-title" style="margin-top:0">Runtime</h2>
    <dl class="detail-grid">${runtimeRow}${rclonexRow}</dl>
    ${
      runtime.ok
        ? ""
        : `<p class="muted">rclone not runnable — see deploy logs (<code>RCLONE_BIN</code>, arch match).</p>`
    }
    ${
      rclonexRuntime && !rclonexRuntime.ok
        ? `<p class="muted">RcloneX is enabled but not runnable — RAR/7Z/ISO extraction will fail. Install the newest rclonex release or set <code>RCLONEX_BIN</code>.</p>`
        : ""
    }
  </div>
  <div class="${backupCls}">
    <h2 class="section-title" style="margin-top:0">Backup</h2>
    <fieldset class="bare-fieldset"${dis}>
    <form id="export-form" method="post" action="/export">
      <input type="hidden" name="csrf_token" value="${esc(csrf ?? "")}">
      <label class="check"><input type="checkbox" name="include_rclone" value="1"> include secrets (rclone.conf, database_url) ${info("Exports contain unencrypted secrets. Only tick it if you store backups somewhere safe.", "include secrets")}</label>
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
    ${running ? `<p class="muted">Task running — options are disabled.</p>` : ""}
    <div class="btn-row">
      <span class="maint-btn"><button class="btn" hx-post="/maintenance/queues" hx-target="#maintenance-result" hx-swap="innerHTML" data-confirm="Clear the queue?|Clear queues"><span class="spinner" aria-hidden="true"></span>Clear queues</button>${info("Deletes queued archives (and their logs). A running engine skips the deleted rows; run count and history are kept.", "Clear queues")}</span>
      <span class="maint-btn"><button class="btn" hx-post="/maintenance/logs" hx-target="#maintenance-result" hx-swap="innerHTML" data-confirm="Clear logs and errors?|Clear logs"${dis}><span class="spinner" aria-hidden="true"></span>Clear logs</button>${info("Wipes log lines and error flags only. Runs and archives are kept.", "Clear logs")}</span>
      <span class="maint-btn"><button class="btn" hx-post="/maintenance/tmp-purge" hx-target="#tmp-purge-result" hx-swap="innerHTML" data-confirm="Clear the tmp directory?|Clear tmp directory"${dis}><span class="spinner" aria-hidden="true"></span>Clear tmp directory</button>${info("Purges stale app-owned run_* directories (honors dry run).", "Clear tmp directory")}</span>
      <span class="maint-btn"><button class="btn danger" hx-post="/maintenance/all" hx-target="#maintenance-result" hx-swap="innerHTML" data-confirm="Clear everything (queue, history, logs, errors, tmp directory)?|Clear everything"${dis}><span class="spinner" aria-hidden="true"></span>Clear everything</button>${info("Queue, history, logs, errors and the tmp directory — next run starts from #1.", "Clear everything")}</span>
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
      if (!loading && window.appUnmark) window.appUnmark(btn);
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
            credentials: "same-origin",
            headers: { "Accept": "application/json" },
          });
          var contentType = res.headers.get("content-type") || "";
          var text = await res.text();
          if (res.status === 401) {
            throw new Error("your session expired — reload the page and sign in again");
          }
          // Proxies/CDNs may rewrite the Content-Type of a download response
          // (or fetch may follow a redirect), so validate the payload instead
          // of trusting headers.
          var parsed = null;
          try { parsed = JSON.parse(text); } catch (_) { /* not JSON */ }
          var isPayload = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
          if (!res.ok || !isPayload) {
            var why = "HTTP " + res.status +
              (contentType ? ", " + contentType : "") +
              (res.redirected ? ", redirected" : "");
            throw new Error("unexpected response from /export (" + why + ")");
          }
          var disposition = res.headers.get("content-disposition") || "";
          var match = /filename="?([^";]+)"?/.exec(disposition);
          var filename = match ? match[1] : "export-" + Date.now() + ".json";
          var blob = new Blob([text], { type: "application/json" });
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

  // Tab selection.
  const tabParam = c.req.query("tab");
  const tab = tabParam === "errors" ? "errors" : "main";
  const kind = tab === "errors" ? "errors" : "main";

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
    <a class="log-tab${tab === "main" ? " active" : ""}" href="/logs?run=${selectedId}&amp;tab=main">Run log</a>
    <a class="log-tab${tab === "errors" ? " active" : ""}" href="/logs?run=${selectedId}&amp;tab=errors">Errors</a>
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

  const { entries, lastId } = await tailRendered(
    { scope: "run", refId: Number(selected.id), kind },
    LOG_TAIL_LIMIT,
  );
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
        <input type="hidden" name="tab" value="${tab}">
        <button class="btn small" type="submit">View</button>
      </form>`;

  // Prefer the stored outcome; fall back to the legacy interrupted flag for
  // rows written before it existed.
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
        reason ? ` — ${esc(reason)}` : ""
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

  const downloadHref = `/download/run/${selected.id}?kind=${kind}`;
  const copyToolbar = `<div class="log-actions" role="toolbar" aria-label="Log actions">
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
  return c.html(layout("Logs", body, "logs", csrfFor(c), "Raw output of each run."));
});

const PW_TOGGLE_SCRIPT = `<script>
document.addEventListener("click", async function (event) {
  var btn = event.target.closest ? event.target.closest("[data-pw-log]") : null;
  if (!btn) return;
  var id = btn.getAttribute("data-pw-log");
  var box = document.getElementById("pw-log-" + id);
  if (!box) return;
  var collapsed = !box.hidden;
  if (collapsed) {
    box.hidden = true;
    btn.textContent = "Log view";
    btn.setAttribute("aria-expanded", "false");
    return;
  }
  if (!box.dataset.loaded) {
    box.innerHTML = '<p class="muted" style="padding:10px 14px">Loading…</p>';
    try {
      var res = await fetch("/logs/archive/" + id + "/fragment");
      box.innerHTML = await res.text();
      box.dataset.loaded = "1";
    } catch (e) {
      box.innerHTML = '<p class="muted" style="padding:10px 14px">Could not load the log.</p>';
    }
  }
  box.hidden = false;
  btn.textContent = "Hide log";
  btn.setAttribute("aria-expanded", "true");
});
</script>`;

pages.get("/errors", async (c) => {
  const running = engineState.running && engineState.runId > 0;
  const [rows, pwRows] = await Promise.all([readErrorRows(store), readPasswordRows()]);
  const body = `<h2 class="section-title" style="margin-top:0">Failed archives ${info("Archives with an error_kind set, newest first. Password-protected archives are excluded — they have their own section below. Copy fetches the raw output of the failing command.", "Failed archives")}</h2>
    <div class="log-actions" role="toolbar" aria-label="Error actions">
      ${running ? `<span class="pill warn" id="livePill">live</span>` : ""}
      <button class="btn small" type="button" data-copy-table="#errorCards">Copy all errors</button>
    </div>
    <div id="errorCards" data-live="${running ? "1" : "0"}">${renderErrorCards(rows)}</div>
    <h2 class="section-title">Password-protected ${info("Skipped during runs: a warning is logged and the run moves on. Delete moves the file to the trash folder; Restore returns it to the queue.", "Password-protected")}</h2>
    ${renderPasswordList(pwRows)}
    ${PW_TOGGLE_SCRIPT}
    <script src="/public/copy.js" defer></script>`;
  return c.html(layout("Errors", body, "errors", csrfFor(c), "Archives that need attention: failures and password-protected files."));
});
