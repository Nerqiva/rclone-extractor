/**
 * UI fragment builders shared across the route modules: the run-control
 * dock (Progress page) and the Configuration form. Kept out of the route
 * modules so routes never import each other for markup.
 */
import { engineState } from "./engine";
import { store, allSettings } from "./db";
import { esc, info } from "./ui";
import { formatBytes } from "./format";
import { encryptionEnabled } from "./crypto";
import { APP_PASSWORD, RCLONE_CONF } from "./config";
import { TMP_DIR_DEFAULT } from "./tmpdir";

export function controlsFragment(): string {
  // Idle state: Start form. Reuse-scan and Start are visually grouped.
  const running = engineState.running;
  if (!running) {
    return `<div id="controls" class="controls-idle">
    <form class="controls-start" hx-post="/run/start" hx-target="#controls" hx-swap="outerHTML">
      <div class="check"><label class="check-inline"><input type="checkbox" name="reuse_scan" value="1"> Reuse previous scan results</label>${info(
        "Reuse the cached scan; fresh scan if stale. Not remembered.",
        "reuse_scan",
      )}</div>
      <div class="btn-row">
        <button class="btn primary" type="submit"><span class="spinner" aria-hidden="true"></span>Start</button>
      </div>
    </form>
  </div>`;
  }
  if (engineState.forceStop) {
    return `<div id="controls" class="btn-row controls-row" hx-get="/dashboard/controls" hx-trigger="every 1s" hx-swap="outerHTML">
    <span class="controls-note warn-line stop-note">Stopping immediately — the current archive was aborted…</span>
    <button class="btn danger solid is-loading btn-stop" disabled><span class="spinner" aria-hidden="true"></span>Stopping…</button>
  </div>`;
  }
  // The Stop button opens the shared stop modal (Soft stop / Hard stop).
  const stage = engineState.stage;
  const activity = engineState.activity;
  const skips: string[] = [];
  if (stage === "listing" && activity === "Listing archives") {
    skips.push(
      `<button class="btn small ghost" hx-post="/run/skip" hx-vals='{"target":"listing"}' hx-target="#controls" hx-swap="outerHTML">Skip listing</button>${info(
        "Stop the scan; continue with the stored queue. This run only.",
        "Skip listing",
      )}`,
    );
  }
  if (activity === "Inspecting archive" && engineState.archiveInFlight) {
    skips.push(
      `<button class="btn small ghost" hx-post="/run/skip" hx-vals='{"target":"inspection"}' hx-target="#controls" hx-swap="outerHTML">Skip inspection</button>${info(
        "Treat inspection as passed for this archive. This run only.",
        "Skip inspection",
      )}`,
    );
  }
  if (stage === "extracting" && engineState.archiveInFlight) {
    skips.push(
      `<button class="btn small ghost" hx-post="/run/skip" hx-vals='{"target":"archive"}' hx-target="#controls" hx-swap="outerHTML">Skip archive</button>${info(
        "Leave this archive queued; it retries next run. This run only.",
        "Skip archive",
      )}`,
    );
  }
  const skipCluster = skips.length
    ? `<span class="skip-cluster" aria-label="Skip controls">\n    ${skips.join("\n    ")}\n    </span>`
    : "";
  const note = engineState.stopRequested
    ? `<span class="controls-note warn-line stop-note">Stop requested — finishing the current archive…</span>`
    : `<span class="controls-note muted">run in progress…</span>`;
  return `<div id="controls" class="btn-row controls-row" hx-get="/dashboard/controls" hx-trigger="every 1s" hx-swap="outerHTML">
    ${note}
    ${skipCluster}
    <button class="btn danger btn-stop" data-modal-open="stop-modal">Stop</button>
  </div>`;
}

function settingRow(
  label: string,
  value: string,
  editor: string,
  opts: { unset?: boolean; key?: string; desc?: string } = {},
): string {
  return `<div class="setting">
    <div class="setting-head">
      <div class="setting-info">
        <span class="setting-label">${esc(label)}${opts.key ? ` <code class="setting-key">${esc(opts.key)}</code>` : ""}</span>
        <span class="setting-value${opts.unset ? " unset" : ""}">${esc(value)}</span>
        ${opts.desc ? `<span class="setting-desc">${esc(opts.desc)}</span>` : ""}
      </div>
      <button type="button" class="btn small" data-edit>Edit</button>
    </div>
    <div class="setting-editor">
      ${editor}
      <div class="btn-row">
        <button class="btn primary" type="submit"><span class="spinner" aria-hidden="true"></span>Save</button>
        <button class="btn" type="button" data-cancel>Cancel</button>
      </div>
    </div>
  </div>`;
}

/** Checkbox row styled like the other settings (no Edit toggle; saved with the form). */
function toggleRow(
  name: string,
  label: string,
  checked: boolean,
  desc: string,
): string {
  return `<label class="setting setting-toggle"><input type="checkbox" name="${esc(name)}"${checked ? " checked" : ""}> <span class="setting-label">${esc(label)} <code class="setting-key">${esc(name)}</code></span>
  <span class="setting-desc">${esc(desc)}</span></label>`;
}

function section(title: string, body: string): string {
  return `<section class="card config-section"><h2 class="section-title" style="margin-top:0">${esc(title)}</h2>${body}</section>`;
}

/** Format a stored size limit in bytes for the collapsed row label. */
function formatSizeLimit(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "no limit";
  return formatBytes(bytes);
}

/** Split a stored size limit (bytes) into an editable value + unit. */
function splitSizeLimit(bytes: number): { value: string; unit: "MB" | "GB" } {
  if (bytes >= 1024 ** 3 && bytes % 1024 ** 3 === 0) {
    return { value: String(bytes / 1024 ** 3), unit: "GB" };
  }
  return { value: String(Number((bytes / 1024 ** 2).toFixed(2))), unit: "MB" };
}

export async function configForm(note = ""): Promise<string> {
  const s = await allSettings();
  const sel = (v: string, o: string) => (v === o ? " selected" : "");
  const backend = store.backend();
  const enc = encryptionEnabled();
  const pwWorks = APP_PASSWORD ? "set" : "not set";

  const storedConf = s.rclone_conf ?? "";
  const effectiveConf = storedConf || RCLONE_CONF;
  const confLabel = !effectiveConf
    ? "not set"
    : storedConf
      ? "set"
      : "from RCLONE_CONF env";
  const maxSizeRaw = Number(s.max_archive_size ?? "0");
  const maxSizeBytes =
    Number.isFinite(maxSizeRaw) && maxSizeRaw > 0 ? Math.floor(maxSizeRaw) : 0;
  const maxSizeSplit = splitSizeLimit(maxSizeBytes);
  const minSizeRaw = Number(s.min_archive_size ?? "0");
  const minSizeBytes =
    Number.isFinite(minSizeRaw) && minSizeRaw > 0 ? Math.floor(minSizeRaw) : 0;
  const minSizeSplit = splitSizeLimit(minSizeBytes);
  const maxSizeTooHigh = maxSizeBytes > 0 && minSizeBytes > 0 && maxSizeBytes < minSizeBytes;
  // While a task is running every setting on this page is out of reach;
  // Clear queues (Maintenance) stays usable. The fieldset disables all
  // nested controls; server-side guards remain as the real enforcement.
  const running = engineState.running;
  const dis = running ? " disabled" : "";
  return `<form id="config-form"${running ? ` class="is-disabled"` : ""} hx-post="/config" hx-encoding="multipart/form-data" hx-target="#config-form" hx-swap="outerHTML">
  ${note}
  ${running ? `<p class="muted">Task running — options are disabled.</p>` : ""}
  <p class="muted">
    Backend: <strong>${esc(backend)}</strong>
    &middot; Encryption: <strong>${enc ? "on" : "off"}</strong>
    <span class="pill ${pwWorks === "not set" ? "err" : "ok"}">APP_PASSWORD ${esc(pwWorks)}</span>
  </p>
  <fieldset class="bare-fieldset"${dis}>
  ${maxSizeTooHigh ? `<p class="note warn-line">Largest archive is smaller than Smallest archive — every archive is excluded.</p>` : ""}
  ${section(
    "Connection",
    settingRow(
      "Scan root",
      s.scan_root || "not set",
      `<label class="field"><input type="text" name="scan_root" value="${esc(s.scan_root ?? "")}" placeholder="remote:path or /local/path" aria-label="scan_root"></label>`,
      {
        unset: !s.scan_root,
        key: "scan_root",
        desc: "rclone remote or local path to scan, e.g. s3:bucket/archives or /data/in.",
      },
    ) +
    settingRow(
      "Extra rclone flags",
      s.remote_flags || "none",
      `<label class="field"><input type="text" name="remote_flags" value="${esc(s.remote_flags ?? "")}" placeholder="--fast-list" aria-label="remote_flags"></label>`,
      { key: "remote_flags", desc: "Flags appended to every rclone command. --config is ignored." },
    ) +
    settingRow(
      "rclone.conf",
      confLabel,
      `<label class="field"><input type="file" name="rclone_conf_file" accept=".conf,text/plain" aria-label="rclone.conf"></label>
    <button type="button" class="btn small" hx-post="/config/rclone-clear" hx-target="#config-form" hx-swap="outerHTML" data-confirm="Clear stored rclone.conf?|Clear"><span class="spinner" aria-hidden="true"></span>Clear stored config</button>`,
      {
        unset: !effectiveConf,
        key: "rclone_conf",
        desc: "Stored config, written before each run. Used when RCLONE_CONF is not set.",
      },
    ),
  )}
  ${section(
    "Selection",
    settingRow(
      "Queue limit",
      s.queue_max ?? "500",
      `<label class="field"><input type="number" name="queue_max" min="1" value="${esc(s.queue_max ?? "500")}" aria-label="queue_max"></label>`,
      { key: "queue_max", desc: "Maximum number of archives queued per run." },
    ) +
    settingRow(
      "Smallest archive",
      formatSizeLimit(minSizeBytes),
      `<label class="field"><div class="field-inline">
        <input type="number" name="min_archive_size" min="0" step="any" value="${esc(minSizeSplit.value)}" placeholder="0" aria-label="min_archive_size">
        <select name="min_archive_size_unit" aria-label="min_archive_size unit">
          <option value="MB"${minSizeSplit.unit === "MB" ? " selected" : ""}>MB</option>
          <option value="GB"${minSizeSplit.unit === "GB" ? " selected" : ""}>GB</option>
        </select>
      </div></label>`,
      {
        unset: minSizeBytes <= 0,
        key: "min_archive_size",
        desc: "Skip archives smaller than this. 0 disables the limit.",
      },
    ) +
    settingRow(
      "Largest archive",
      formatSizeLimit(maxSizeBytes),
      `<label class="field"><div class="field-inline">
        <input type="number" name="max_archive_size" min="0" step="any" value="${esc(maxSizeSplit.value)}" placeholder="0" aria-label="max_archive_size">
        <select name="max_archive_size_unit" aria-label="max_archive_size unit">
          <option value="MB"${maxSizeSplit.unit === "MB" ? " selected" : ""}>MB</option>
          <option value="GB"${maxSizeSplit.unit === "GB" ? " selected" : ""}>GB</option>
        </select>
      </div></label>`,
      {
        unset: maxSizeBytes <= 0,
        key: "max_archive_size",
        desc: "Skip archives larger than this. 0 disables the limit.",
      },
    ) +
    settingRow(
      "Sort by",
      s.sort_by ?? "path",
      `<label class="field"><select name="sort_by" aria-label="sort_by">
        <option value="path"${sel(s.sort_by ?? "path", "path")}>path</option>
        <option value="size"${sel(s.sort_by ?? "path", "size")}>size</option>
      </select></label>`,
      { key: "sort_by", desc: "Process archives in path or size order." },
    ) +
    settingRow(
      "Sort direction",
      s.sort_dir ?? "asc",
      `<label class="field"><select name="sort_dir" aria-label="sort_dir">
        <option value="asc"${sel(s.sort_dir ?? "asc", "asc")}>ascending</option>
        <option value="desc"${sel(s.sort_dir ?? "asc", "desc")}>descending</option>
      </select></label>`,
      { key: "sort_dir", desc: "Ascending or descending." },
    ),
  )}
  ${section(
    "Extract",
    settingRow(
      "Extract to",
      s.tmp_dir || TMP_DIR_DEFAULT,
      `<label class="field"><input type="text" name="tmp_dir" value="${esc(s.tmp_dir ?? "")}" placeholder="${TMP_DIR_DEFAULT}" aria-label="tmp_dir"></label>`,
      { key: "tmp_dir", desc: "Where archives are unpacked. Relative paths resolve inside the scan root." },
    ) +
    settingRow(
      "Trash folder",
      s.trash_subdir ?? "trash",
      `<label class="field"><input type="text" name="trash_subdir" value="${esc(s.trash_subdir ?? "trash")}" aria-label="trash_subdir"></label>`,
      { key: "trash_subdir", desc: "Folder processed archives are moved to." },
    ),
  )}
  ${section(
    "Behaviour",
    toggleRow("dry_run", "Dry run", s.dry_run === "1", "Runs everything with rclone's --dry-run; nothing moves or deletes.") +
    toggleRow("resume", "Resume interrupted runs", s.resume === "1", "Re-queue archives that were mid-extraction when the app stopped.") +
    toggleRow("auto_skip_known", "Auto-skip known dumps", (s.auto_skip_known ?? "1") === "1", "Skip torrent/website dumps that were skipped as such before."),
  )}
  ${section(
    "RcloneX",
    toggleRow("rclonex", "Enable RcloneX", s.rclonex === "1", "Extract RAR/7Z/ISO with rclonex; everything else stays on rclone.") +
    toggleRow("rclonex_skip_inspection", "Skip inspection for RcloneX formats", (s.rclonex_skip_inspection ?? "1") === "1", "Don't list RAR/7Z contents (rclone cannot). ISO is always skipped.") +
    `<div class="setting setting-toggle setting-compound">
      <span class="setting-label"><input type="checkbox" name="rclonex_archive_password_enabled" id="rclonex-pw"${s.rclonex_archive_password_enabled === "1" ? " checked" : ""}> <label for="rclonex-pw">Archive password <code class="setting-key">rclonex_archive_password</code></label></span>
      <span class="setting-desc">Password for encrypted RAR/7Z archives. Blank keeps the stored one.</span>
      <span class="field-inline">
        <input class="check-input" type="password" name="rclonex_archive_password" placeholder="${s.rclonex_archive_password ? "leave blank to keep stored" : "not set"}" autocomplete="new-password" aria-label="rclonex archive password">
        <button type="button" class="btn small" hx-post="/config/rclonex-clear" hx-target="#config-form" hx-swap="outerHTML" data-confirm="Clear stored archive password?|Clear password"><span class="spinner" aria-hidden="true"></span>Clear</button>
      </span>
    </div>`,
  )}
  ${section(
    "Advanced",
    `<div class="setting setting-toggle setting-compound">
      <span class="setting-label"><input type="checkbox" name="rclonex_window_size_enabled" id="rclonex-win"${s.rclonex_window_size_enabled === "1" ? " checked" : ""}> <label for="rclonex-win">Override rclonex window size <code class="setting-key">rclonex_window_size</code></label></span>
      <span class="setting-desc">Sliding-window cache in bytes for rclonex reads. 0 disables. Default: 16777216.</span>
      <span class="field-inline"><input class="check-input small-num" type="number" min="0" name="rclonex_window_size" value="${esc(s.rclonex_window_size ?? "16777216")}" aria-label="rclonex window size"></span>
    </div>`,
  )}
  <div class="btn-row">
    <button class="btn primary" type="submit"><span class="spinner" aria-hidden="true"></span>Save</button>
  </div>
  </fieldset>
</form>`;
}
