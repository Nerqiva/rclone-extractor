(function () {
  "use strict";

  // One client runtime for every page. Server-rendered markup stays the source
  // of truth; this file only adds behavior to elements that exist.

  // morphdom patches changed nodes in place, so a poll leaves text selection
  // and scroll position alone. childrenOnly keeps target ids and JS attributes.
  function morphInto(target, html) {
    // A poll must not close a log the reader has open. Save its contents and
    // restored state across the morph, then put them back on the new nodes.
    var openLogs = [];
    if (target.querySelectorAll) {
      var before = target.querySelectorAll(".log-viewer");
      for (var b = 0; b < before.length; b++) {
        if (!before[b].hidden) {
          openLogs.push({
            id: before[b].id,
            html: before[b].innerHTML,
            loaded: before[b].dataset.loaded || "",
          });
        }
      }
    }
    var wrap = document.createElement("div");
    if (typeof html === "string") wrap.innerHTML = html;
    else while (html.firstChild) wrap.appendChild(html.firstChild);
    var root = wrap.firstElementChild;
    if (root && root.id === target.id && root.nodeName === target.nodeName) {
      morphdom(target, root);
    } else {
      morphdom(target, wrap, { childrenOnly: true });
    }
    for (var i = 0; i < openLogs.length; i++) {
      var saved = openLogs[i];
      var after = target.querySelectorAll(".log-viewer");
      for (var j = 0; j < after.length; j++) {
        if (after[j].id !== saved.id) continue;
        after[j].hidden = false;
        after[j].dataset.loaded = saved.loaded;
        if (!after[j].innerHTML && saved.html) after[j].innerHTML = saved.html;
        var toggleId = after[j].id.split("-log-").pop();
        var toggle = target.querySelector('[data-log-toggle="' + toggleId + '"]');
        if (toggle) {
          toggle.textContent = "Hide log";
          toggle.setAttribute("aria-expanded", "true");
        }
        break;
      }
    }
  }
  window.appMorph = morphInto;

  if (window.htmx) {
    htmx.defineExtension("app-morph", {
      isInlineSwap: function (style) { return style === "morphdom"; },
      handleSwap: function (style, target, fragment) {
        if (style !== "morphdom") return false;
        morphInto(target, fragment.cloneNode(true));
        return [target];
      },
    });
  }

  function toast(message, kind) {
    var region = document.getElementById("toast-region");
    if (!region) return;
    var el = document.createElement("div");
    el.className = "toast " + (kind || "ok");
    el.textContent = message;
    region.appendChild(el);
    var lifetime = kind === "err" ? 8000 : 3200;
    requestAnimationFrame(function () { el.classList.add("show"); });
    window.setTimeout(function () { el.classList.remove("show"); }, lifetime);
    window.setTimeout(function () { el.remove(); }, lifetime + 400);
  }
  window.appToast = toast;

  // A single registry replaces the page's separate download and queue timers.
  // Nothing runs while the tab is hidden, and each task keeps its own cadence.
  var polls = [];
  function registerPoll(name, fn, interval, enabled) {
    var poll = {
      name: name,
      fn: fn,
      interval: interval,
      enabled: enabled || function () { return true; },
      last: 0,
    };
    polls.push(poll);
    if (poll.enabled()) poll.fn();
  }
  window.setInterval(function () {
    if (document.hidden) return;
    var now = Date.now();
    for (var i = 0; i < polls.length; i++) {
      var p = polls[i];
      if (now - p.last >= p.interval && p.enabled()) {
        p.last = now;
        p.fn();
      }
    }
  }, 250);

  function actionButtons(elt) {
    if (!elt || !elt.querySelectorAll) return [];
    var trigger = elt.getAttribute && elt.getAttribute("hx-trigger");
    if (trigger && trigger.indexOf("every") !== -1) return [];
    if (elt.matches && elt.matches("button.btn")) return [elt];
    return Array.prototype.slice.call(elt.querySelectorAll("button.btn"));
  }

  function inflight(button, delta) {
    var n = Math.max(0, Number(button.dataset.inflight || 0) + delta);
    if (n) button.dataset.inflight = String(n);
    else delete button.dataset.inflight;
  }

  var BUSY_SAFETY_MS = 60000;
  function scheduleSafety(button) {
    button.dataset.busySafety = String(
      window.setTimeout(function () {
        // A slow request still owns the button. Wait for its response instead
        // of freeing a control whose work is in progress.
        if (Number(button.dataset.inflight || 0) > 0) {
          scheduleSafety(button);
          return;
        }
        mark(button, false);
      }, BUSY_SAFETY_MS),
    );
  }
  function mark(button, busy) {
    if (!button) return;
    var isAnchor = button.tagName === "A";
    if (busy) {
      if (!isAnchor) button.disabled = true;
      button.classList.add("is-loading");
      button.setAttribute("aria-busy", "true");
      if (!button.querySelector(".spinner")) {
        var sp = document.createElement("span");
        sp.className = "spinner";
        sp.setAttribute("aria-hidden", "true");
        sp.setAttribute("data-injected", "1");
        button.insertBefore(sp, button.firstChild);
      }
      if (button.dataset.busySafety) window.clearTimeout(Number(button.dataset.busySafety));
      scheduleSafety(button);
      return;
    }
    if (button.dataset.busySafety) {
      window.clearTimeout(Number(button.dataset.busySafety));
      delete button.dataset.busySafety;
    }
    if (!isAnchor) button.disabled = false;
    button.classList.remove("is-loading");
    button.removeAttribute("aria-busy");
    var injected = button.querySelectorAll('.spinner[data-injected="1"]');
    for (var i = 0; i < injected.length; i++) injected[i].remove();
  }
  window.appUnmark = function (button) { mark(button, false); };

  document.body.addEventListener("htmx:configRequest", function (event) {
    var meta = document.querySelector('meta[name="csrf-token"]');
    if (meta && meta.content) event.detail.headers["X-CSRF-Token"] = meta.content;
  });
  document.body.addEventListener("htmx:beforeRequest", function (event) {
    actionButtons(event.detail && event.detail.elt).forEach(function (b) {
      inflight(b, 1);
      mark(b, true);
    });
  });
  document.body.addEventListener("htmx:afterRequest", function (event) {
    actionButtons(event.detail && event.detail.elt).forEach(function (b) {
      inflight(b, -1);
      mark(b, false);
    });
  });

  document.body.addEventListener("click", function (event) {
    var btn = event.target.closest ? event.target.closest(".btn") : null;
    if (!btn) return;
    if (btn.getAttribute("type") === "submit") return;
    var cfm = btn.closest("[data-confirm]");
    if (cfm && !cfm.hasAttribute("data-confirmed")) return;
    if (btn.id === "confirm-ok" || btn.disabled) return;
    if (btn.getAttribute("aria-disabled") === "true") return;
    if (btn.closest("[data-modal-open], [data-modal-close], [data-edit], [data-cancel]")) return;
    var trg = btn.getAttribute("hx-trigger");
    if (trg && trg.indexOf("every") !== -1) return;
    mark(btn, true);
  }, true);

  document.body.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || !form.querySelector) return;
    var btn = form.querySelector('button[type="submit"]');
    if (btn) mark(btn, true);
  }, true);

  document.body.addEventListener("htmx:beforeSwap", function (event) {
    var target = event.detail && event.detail.target;
    if (target && target.querySelector && target.querySelector(".info-tip.open")) {
      event.preventDefault();
    }
  });
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) window.location.reload();
  });

  function closeInfoTips() {
    var open = document.querySelectorAll(".info-tip.open");
    for (var i = 0; i < open.length; i++) {
      var btn = open[i].querySelector(".info-i");
      if (btn) btn.setAttribute("aria-expanded", "false");
      open[i].classList.remove("open");
    }
  }
  document.body.addEventListener("click", function (event) {
    var tip = event.target.closest ? event.target.closest(".info-i") : null;
    if (!tip) { closeInfoTips(); return; }
    event.preventDefault();
    event.stopPropagation();
    var wrap = tip.closest(".info-tip");
    var wasOpen = wrap.classList.contains("open");
    closeInfoTips();
    if (!wasOpen) {
      wrap.classList.add("open");
      tip.setAttribute("aria-expanded", "true");
      var bubble = wrap.querySelector(".info-tip-bubble");
      var button = tip.getBoundingClientRect();
      if (bubble && button.bottom + bubble.offsetHeight + 12 > window.innerHeight) {
        wrap.classList.add("flip");
      } else {
        wrap.classList.remove("flip");
      }
    }
  }, true);
  window.addEventListener("scroll", closeInfoTips, true);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeInfoTips();
  });

  var lastOpener = null;
  var pendingConfirm = null;
  function showModal(id) {
    var overlay = document.getElementById(id);
    if (!overlay) return;
    lastOpener = document.activeElement;
    overlay.hidden = false;
    var buttons = overlay.querySelectorAll(".modal-actions button");
    var benign = buttons[buttons.length - 1] || overlay.querySelector("button");
    if (benign) benign.focus();
  }
  function hideModals() {
    var overlays = document.querySelectorAll(".modal-overlay");
    for (var i = 0; i < overlays.length; i++) overlays[i].hidden = true;
    pendingConfirm = null;
    if (lastOpener && document.contains(lastOpener) && lastOpener.focus) lastOpener.focus();
    lastOpener = null;
  }
  document.body.addEventListener("click", function (event) {
    var open = event.target.closest("[data-modal-open]");
    if (open) {
      event.preventDefault();
      showModal(open.getAttribute("data-modal-open"));
      return;
    }
    if (event.target.closest("[data-modal-close]") || event.target.classList.contains("modal-overlay")) {
      hideModals();
      return;
    }
    var cfm = event.target.closest("[data-confirm]");
    if (cfm && !cfm.hasAttribute("data-confirmed")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      pendingConfirm = cfm;
      var title = document.getElementById("confirm-modal-title");
      var ok = document.getElementById("confirm-ok");
      var parts = String(cfm.getAttribute("data-confirm") || "|").split("|");
      if (title) title.textContent = parts[0] || "Confirm";
      if (ok) ok.textContent = parts[1] || "Confirm";
      showModal("confirm-modal");
    }
  }, true);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") hideModals();
    if (event.key !== "Tab") return;
    var open = document.querySelector(".modal-overlay:not([hidden])");
    if (!open) return;
    var focusables = open.querySelectorAll("button, [href], input, select, textarea");
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  document.body.addEventListener("click", function (event) {
    if (event.target.id !== "confirm-ok") return;
    if (!pendingConfirm) { hideModals(); return; }
    var btn = pendingConfirm;
    pendingConfirm = null;
    btn.setAttribute("data-confirmed", "1");
    hideModals();
    btn.click();
    btn.removeAttribute("data-confirmed");
  });
  document.body.addEventListener("appToast", function (event) {
    var detail = event.detail || {};
    if (typeof detail === "string") toast(detail, "ok");
    else toast(detail.message || "", detail.kind || "ok");
  });

  function queuePanel() { return document.getElementById("queuePanel"); }
  function syncQueueButtons() {
    var panel = queuePanel();
    if (!panel) return;
    var toggles = document.querySelectorAll("[data-queue-toggle]");
    for (var i = 0; i < toggles.length; i++) {
      var btn = toggles[i];
      var hidden = panel.hidden;
      btn.textContent = (hidden ? "Show Queue (" : "Hide Queue (") +
        (btn.getAttribute("data-queue-count") || "0") + ")";
      btn.setAttribute("aria-expanded", hidden ? "false" : "true");
    }
  }
  function loadQueue(page, quiet) {
    var body = document.getElementById("queuePanelBody");
    if (!body) return;
    body.setAttribute("data-page", String(page));
    if (!quiet) body.innerHTML = '<p class="muted">Loading…</p>';
    fetch("/dashboard/queue?page=" + encodeURIComponent(String(page)), {
      credentials: "same-origin", cache: "no-store",
    })
      .then(function (response) { return response.ok ? response.text() : ""; })
      .then(function (html) { morphInto(body, html || '<p class="muted">Could not load the queue.</p>'); })
      .catch(function () { morphInto(body, '<p class="muted">Could not load the queue.</p>'); });
  }
  document.body.addEventListener("click", function (event) {
    var toggle = event.target.closest ? event.target.closest("[data-queue-toggle]") : null;
    if (toggle) {
      var panel = queuePanel();
      if (!panel) return;
      panel.hidden = !panel.hidden;
      if (!panel.hidden) loadQueue(1);
      syncQueueButtons();
      window.appUnmark(toggle);
      return;
    }
    var pager = event.target.closest ? event.target.closest("[data-queue-page]") : null;
    if (pager) {
      loadQueue(Number(pager.getAttribute("data-queue-page")));
      window.appUnmark(pager);
    }
  });
  document.body.addEventListener("htmx:afterSwap", function (event) {
    var target = event.detail && event.detail.target;
    if (target && target.id === "controls") syncQueueButtons();
  });
  syncQueueButtons();
  registerPoll("queue", function () {
    var panel = queuePanel();
    var body = document.getElementById("queuePanelBody");
    if (!panel || panel.hidden || !body) return;
    syncQueueButtons();
    loadQueue(Number(body.getAttribute("data-page") || "1"), true);
  }, 3000, function () { return !!queuePanel(); });

  function greyDownloads(active) {
    var els = document.querySelectorAll("[data-download-archive]");
    for (var i = 0; i < els.length; i++) {
      els[i].classList.toggle("is-download-disabled", active);
      els[i].setAttribute("aria-disabled", active ? "true" : "false");
      if (!active) mark(els[i], false);
    }
  }
  function pollDownloads() {
    fetch("/download/archive-file/active", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && typeof j.active === "number") greyDownloads(j.active > 0); })
      .catch(function () { /* transient; next tick retries */ });
  }
  document.body.addEventListener("click", function (event) {
    var el = event.target.closest ? event.target.closest("[data-download-archive]") : null;
    if (!el) return;
    if (el.classList.contains("is-download-disabled")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toast("A download is already in progress; wait for it to finish.", "err");
      return;
    }
    mark(el, true);
    pollDownloads();
  }, true);
  registerPoll("downloads", pollDownloads, 1500, function () {
    return !!document.querySelector("[data-download-archive]");
  });

  var railToggle = document.getElementById("rail-toggle");
  var railOverlay = document.getElementById("rail-overlay");
  if (railToggle && railOverlay) {
    function setRail(open) {
      document.body.classList.toggle("rail-open", open);
      railToggle.setAttribute("aria-expanded", String(open));
    }
    var stored = null;
    try { stored = localStorage.getItem("rail-open"); } catch (e) { stored = null; }
    setRail(!window.matchMedia("(max-width: 719px)").matches && stored !== "0");
    railToggle.addEventListener("click", function () {
      var open = !document.body.classList.contains("rail-open");
      setRail(open);
      try { localStorage.setItem("rail-open", open ? "1" : "0"); } catch (e) { /* storage disabled */ }
    });
    railOverlay.addEventListener("click", function () { setRail(false); });
  }

  document.body.addEventListener("click", function (event) {
    var edit = event.target.closest ? event.target.closest("[data-edit]") : null;
    if (edit) {
      var setting = edit.closest(".setting");
      if (setting) {
        setting.classList.add("editing");
        var focusable = setting.querySelector("input, textarea, select");
        if (focusable) focusable.focus();
      }
      return;
    }
    var cancel = event.target.closest ? event.target.closest("[data-cancel]") : null;
    if (cancel) {
      var editing = cancel.closest(".setting");
      if (editing) editing.classList.remove("editing");
      return;
    }
    var toggle = event.target.closest ? event.target.closest("[data-log-toggle]") : null;
    if (toggle) toggleLog(toggle);
  });

  function toggleLog(btn) {
    var id = btn.getAttribute("data-log-toggle");
    var boxId = btn.getAttribute("aria-controls");
    var box = boxId ? document.getElementById(boxId) : null;
    if (!box || !id) return;
    if (!box.hidden) {
      box.hidden = true;
      btn.textContent = "Log view";
      btn.setAttribute("aria-expanded", "false");
      window.appUnmark(btn);
      return;
    }
    if (!box.dataset.loaded) {
      box.innerHTML = '<p class="muted" style="padding:10px 14px">Loading…</p>';
      fetch("/logs/archive/" + encodeURIComponent(id) + "/fragment?limit=300", {
        credentials: "same-origin", cache: "no-store",
      })
        .then(function (res) { return res.ok ? res.text() : null; })
        .then(function (html) {
          if (html === null) {
            box.innerHTML = '<p class="muted" style="padding:10px 14px">Could not load the log.</p>';
            return;
          }
          box.innerHTML = html;
          box.dataset.loaded = "1";
        })
        .catch(function () {
          box.innerHTML = '<p class="muted" style="padding:10px 14px">Could not load the log.</p>';
        });
    }
    box.hidden = false;
    btn.textContent = "Hide log";
    btn.setAttribute("aria-expanded", "true");
    window.appUnmark(btn);
  }

  function setLoading(btn, loading) {
    if (!btn) return;
    btn.disabled = loading;
    btn.classList.toggle("is-loading", loading);
    if (!loading) window.appUnmark(btn);
    var label = btn.querySelector(".btn-label");
    if (!label) return;
    if (!btn.dataset.idleLabel) btn.dataset.idleLabel = label.textContent;
    label.textContent = loading ? (btn.dataset.loadingLabel || "Working…") : btn.dataset.idleLabel;
  }

  var exportForm = document.getElementById("export-form");
  if (exportForm) {
    exportForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (exportForm.include_rclone && exportForm.include_rclone.checked &&
          !window.confirm("The export will contain unencrypted secrets: rclone.conf, database_url and the archive password. Continue?")) {
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
        if (res.status === 401) throw new Error("your session expired — reload the page and sign in again");
        var parsed = null;
        try { parsed = JSON.parse(text); } catch (_) { /* not JSON */ }
        var isPayload = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
        if (!res.ok || !isPayload) {
          throw new Error("unexpected response from /export (HTTP " + res.status +
            (contentType ? ", " + contentType : "") + (res.redirected ? ", redirected" : "") + ")");
        }
        var disposition = res.headers.get("content-disposition") || "";
        var match = /filename="?([^";]+)"?/.exec(disposition);
        var filename = match ? match[1] : "export-" + Date.now() + ".json";
        var url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        var link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
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
      setLoading(btn, true);
      try {
        var fileInput = importForm.querySelector('input[type="file"]');
        if (fileInput && (!fileInput.files || fileInput.files.length === 0)) {
          toast("Choose a backup .json file first.", "err");
          return;
        }
        if (!window.confirm("Importing a backup overwrites matching rows in the current database. Continue?")) return;
        var res = await fetch(importForm.action, { method: "POST", body: new FormData(importForm) });
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

  var deferred = document.querySelectorAll("[data-app-toast]");
  for (var d = 0; d < deferred.length; d++) {
    toast(deferred[d].getAttribute("data-app-toast"), deferred[d].getAttribute("data-toast-kind") || "err");
  }
})();
