import { Hono } from "hono";
import { store } from "../db";
import { layout, esc } from "../ui";
import { configForm } from "./actions";
import { encryptionEnabled } from "../crypto";
import { engineState } from "../engine";

export const pages = new Hono();

pages.get("/", (c) =>
  c.html(
    layout(
      "Task progress",
      `<div class="page-toolbar">
        <div id="controls" hx-get="/dashboard/controls" hx-trigger="load" hx-swap="outerHTML"></div>
      </div>
      <div hx-get="/dashboard/fragment" hx-trigger="load, every 1s" hx-swap="innerHTML">
        <p class="muted">Loading…</p>
      </div>`,
      "dashboard",
    ),
  ),
);

pages.get("/config", async (c) => {
  const extra = `<div class="card">
    <h2 class="section-title" style="margin-top:0">Backup</h2>
    <form id="export-form" method="post" action="/export">
      <label class="check"><input type="checkbox" name="include_rclone" value="1"> include secrets (rclone.conf, database_url)</label>
      <button class="btn" type="submit" data-loading-label="Exporting…"><span class="spinner" aria-hidden="true"></span><span class="btn-label">Export JSON</span></button>
    </form>
    <form id="import-form" style="margin-top:14px" method="post" action="/import" enctype="multipart/form-data">
      <label class="field"><span>Import backup (.json)</span><input type="file" name="archive" accept=".json,application/json"></label>
      <button class="btn danger" type="submit" data-loading-label="Importing…"><span class="spinner" aria-hidden="true"></span><span class="btn-label">Import (replaces data)</span></button>
    </form>
    ${
      encryptionEnabled()
        ? ""
        : `<p class="muted">Set the <code>SECRET_KEY</code> env var to encrypt stored secrets.</p>`
    }
  </div>
  <div id="toast-region" class="toast-region" role="status" aria-live="polite"></div>
  <script>
  (function () {
    var toastRegion = document.getElementById("toast-region");

    function toast(message, kind) {
      if (!toastRegion) return;
      var el = document.createElement("div");
      el.className = "toast " + (kind || "ok");
      el.textContent = message;
      toastRegion.appendChild(el);
      requestAnimationFrame(function () { el.classList.add("show"); });
      setTimeout(function () {
        el.classList.remove("show");
        setTimeout(function () { el.remove(); }, 200);
      }, 4200);
    }

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
  return c.html(layout("Configuration", (await configForm()) + extra, "config"));
});

pages.get("/logs", async (c) => {
  const runs = await store.query<{
    id: number;
    started_at: string;
    finished_at: string | null;
  }>("SELECT id, started_at, finished_at FROM runs ORDER BY id DESC LIMIT 50");

  if (runs.length === 0) {
    return c.html(
      layout(
        "Logs",
        `<div class="card"><p class="muted">No runs yet. Start a task from the Progress page.</p></div>`,
        "logs",
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

  const options = runs
    .map(
      (r) =>
        `<option value="${r.id}"${Number(r.id) === selectedId ? " selected" : ""}>Run #${r.id} · ${esc(
          r.started_at,
        )} · ${r.finished_at ? "finished" : "in progress"}</option>`,
    )
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

  const statusPill = isLive
    ? `<span class="pill warn">live</span>`
    : `<span class="pill ${selected.finished_at ? "ok" : "warn"}">${
        selected.finished_at ? "finished" : "incomplete"
      }</span>`;

  const meta = `<div class="log-meta">
    ${statusPill}
    <span>Run #${selected.id}</span>
    <span class="muted">${esc(selected.started_at)}${
      selected.finished_at ? ` → ${esc(selected.finished_at)}` : ""
    }</span>
    <a class="btn small" href="/download/run/${selected.id}?kind=${kind}">Download ${
      kind === "errors" ? "errors" : "log"
    }</a>
  </div>`;

  const body = `<div class="log-toolbar">
      ${picker}
      ${tabs}
    </div>
    ${meta}
    <div id="log-output" hx-get="/logs/fragment?run=${selected.id}&amp;kind=${kind}" hx-trigger="load, every 2s" hx-swap="innerHTML">
      <p class="muted">Loading…</p>
    </div>`;
  return c.html(layout("Logs", body, "logs"));
});

pages.get("/errors", (c) => {
  const body = `<div class="table-wrap"><table>
      <thead><tr><th>Archive</th><th>Kind</th><th>Updated</th><th></th></tr></thead>
      <tbody hx-get="/errors/fragment" hx-trigger="load, every 5s" hx-swap="innerHTML">
        <tr><td colspan="4" class="muted">Loading…</td></tr>
      </tbody></table></div>`;
  return c.html(layout("Errors", body, "errors"));
});
