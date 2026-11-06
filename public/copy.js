/* Copy and incremental-refresh helpers for the logs and errors pages.
 * No dependencies, safe to run on every page. */
(function () {
  "use strict";

  var TOAST_TIMEOUT_MS = 3200;

  function toast(message, kind) {
    var region = document.getElementById("toast-region");
    if (!region) return;
    var el = document.createElement("div");
    el.className = "toast " + (kind || "ok");
    el.textContent = message;
    region.appendChild(el);
    requestAnimationFrame(function () {
      el.classList.add("show");
    });
    window.setTimeout(function () {
      el.classList.remove("show");
    }, TOAST_TIMEOUT_MS);
    window.setTimeout(function () {
      el.remove();
    }, TOAST_TIMEOUT_MS + 400);
  }

  function isSecureContext() {
    try {
      return window.isSecureContext === true;
    } catch (_) {
      return false;
    }
  }

  async function copyText(text) {
    if (isSecureContext() && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // Plain-HTTP fallback (self-hosted LAN deployments).
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } finally {
      ta.remove();
    }
    if (!ok) throw new Error("clipboard unavailable");
  }

  async function fetchText(url) {
    var response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.text();
  }

  function selectionText(selector) {
    var sel = window.getSelection();
    if (!sel) return "";
    if (selector) {
      var target = document.querySelector(selector);
      if (!target) return "";
      if (!target.contains(sel.anchorNode) && !target.contains(sel.focusNode)) {
        return "";
      }
    }
    return sel.toString();
  }

  function selectAll(selector) {
    var target = document.querySelector(selector);
    if (!target) return false;
    var range = document.createRange();
    range.selectNodeContents(target);
    var sel = window.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  function tableAsText(selector) {
    var table = document.querySelector(selector);
    if (!table) return "";
    var rows = table.querySelectorAll("tbody tr");
    var lines = ["archive\tkind\tlast update"];
    rows.forEach(function (row) {
      var cells = row.querySelectorAll("td");
      if (cells.length < 3) return;
      var path = cells[0].textContent || "";
      var kind = cells[1].textContent || "";
      var updated = cells[2].textContent || "";
      lines.push(
        [path.trim(), kind.trim(), updated.trim()]
          .map(function (s) {
            return s.replace(/\s+/g, " ");
          })
          .join("\t"),
      );
    });
    return lines.join("\n");
  }

  async function handleCopyUrl(button) {
    var url = button.getAttribute("data-copy-url");
    if (!url) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      var text = await fetchText(url);
      await copyText(text);
      toast("Copied " + text.split("\n").length + " line(s)");
    } catch (err) {
      toast("Copy failed: " + (err && err.message ? err.message : String(err)), "err");
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  async function handleCopySelection(button) {
    var selector = button.getAttribute("data-copy-selection");
    var text = selectionText(selector);
    if (!text.trim()) {
      toast("Nothing selected", "err");
      return;
    }
    try {
      await copyText(text);
      toast("Copied selection");
    } catch (err) {
      toast("Copy failed", "err");
    }
  }

  async function handleCopyTable(button) {
    var selector = button.getAttribute("data-copy-table");
    var text = tableAsText(selector);
    if (!text.trim()) {
      toast("No rows to copy", "err");
      return;
    }
    try {
      await copyText(text);
      toast("Copied " + (text.split("\n").length - 1) + " error(s)");
    } catch (err) {
      toast("Copy failed", "err");
    }
  }

  function handleSelect(button) {
    var selector = button.getAttribute("data-select");
    if (!selectAll(selector)) {
      toast("Nothing to select", "err");
      return;
    }
    toast("Selected");
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;

    var urlBtn = target.closest("[data-copy-url]");
    if (urlBtn) {
      event.preventDefault();
      void handleCopyUrl(urlBtn);
      return;
    }
    var selBtn = target.closest("[data-copy-selection]");
    if (selBtn) {
      event.preventDefault();
      void handleCopySelection(selBtn);
      return;
    }
    var tableBtn = target.closest("[data-copy-table]");
    if (tableBtn) {
      event.preventDefault();
      void handleCopyTable(tableBtn);
      return;
    }
    var selectBtn = target.closest("[data-select]");
    if (selectBtn) {
      event.preventDefault();
      handleSelect(selectBtn);
    }
  });

  /* ---- live log view ---- */

  var pre = document.getElementById("logTail");
  if (pre && pre.dataset.live === "1") {
    var runId = Number(pre.dataset.run);
    var kind = pre.dataset.kind;
    var lastId = Number(pre.dataset.lastId || "0");

    function appendLines(lines) {
      if (!lines || !lines.length) return;
      var nearBottom =
        pre.scrollHeight - pre.scrollTop - pre.clientHeight < 80;
      var current = pre.textContent
        ? pre.textContent.split("\n").filter(Boolean)
        : [];
      var merged = current.concat(lines);
      // Keep the DOM bounded for long runs.
      if (merged.length > 1500) merged = merged.slice(merged.length - 1500);
      pre.textContent = merged.join("\n");
      if (nearBottom) pre.scrollTop = pre.scrollHeight;
    }

    function markFinished() {
      pre.dataset.live = "0";
      var pill = document.getElementById("livePill");
      if (pill) {
        pill.className = "pill ok";
        pill.textContent = "finished";
      }
      var note = document.getElementById("liveNote");
      if (note) note.textContent = "session finished — polling stopped";
    }

    function poll() {
      if (document.hidden) return;
      fetch(
        "/logs/fragment?run=" +
          encodeURIComponent(String(runId)) +
          "&kind=" +
          encodeURIComponent(kind) +
          "&after=" +
          String(lastId),
        { credentials: "same-origin", cache: "no-store" },
      )
        .then(function (response) {
          if (!response.ok) return null;
          return response.json();
        })
        .then(function (data) {
          if (!data) return;
          if (Array.isArray(data.lines) && data.lines.length) {
            appendLines(data.lines);
            var next = Number(data.lastId);
            if (Number.isFinite(next) && next >= lastId) {
              lastId = next;
              pre.dataset.lastId = String(lastId);
            }
          }
          if (data.live === false) {
            window.clearInterval(timer);
            markFinished();
          }
        })
        .catch(function () {
          /* transient network error; retry on the next tick */
        });
    }

    var timer = window.setInterval(poll, 2000);
    poll();
  }

  /* ---- live errors table ---- */

  var tbody = document.getElementById("errorsBody");
  if (tbody && tbody.dataset.live === "1") {
    var pollErrors = function () {
      if (document.hidden) return;
      fetch("/errors/fragment", {
        credentials: "same-origin",
        cache: "no-store",
      })
        .then(function (response) {
          if (!response.ok) return;
          var live = response.headers.get("X-Engine-Live") !== "0";
          return response.text().then(function (html) {
            tbody.innerHTML = html;
            if (!live) {
              window.clearInterval(errorsTimer);
              tbody.dataset.live = "0";
              var pill = document.getElementById("livePill");
              if (pill) {
                pill.className = "pill ok";
                pill.textContent = "finished";
              }
            }
          });
        })
        .catch(function () {
          /* transient network error; retry on the next tick */
        });
    };
    var errorsTimer = window.setInterval(pollErrors, 3000);
  }
})();
