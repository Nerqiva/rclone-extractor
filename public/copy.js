(function () {
  "use strict";

  function toast(message, kind) {
    if (typeof window.appToast === "function") window.appToast(message, kind);
  }

  // Live preview state is shared by the run-log viewer and the Errors page:
  // both pause on scroll-up and resume from the last fetched position.
  var setLogLive = function () {};
  var setErrorsLive = function () {};
  var manualPause = { log: false, errors: false };

  function nearBottom(box) {
    return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  }

  function syncToggle(which, on) {
    var btn = document.querySelector('[data-live-toggle="' + which + '"]');
    if (!btn) return;
    btn.textContent = on ? "Live preview" : "Manual view";
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    if (window.appUnmark) window.appUnmark(btn);
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

  function tableAsText(selector) {
    var container = document.querySelector(selector);
    if (!container) return "";
    var cards = container.querySelectorAll(".error-card");
    if (cards.length === 0) return "";
    var lines = ["archive\tkind\tlast update"];
    cards.forEach(function (card) {
      var name = card.querySelector(".error-name");
      var pill = card.querySelector(".pill");
      var muted = card.querySelector(".error-card-foot .muted");
      lines.push(
        [
          (name ? name.textContent : "").trim(),
          (pill ? pill.textContent : "").trim(),
          (muted ? muted.getAttribute("title") || muted.textContent : "").trim(),
        ].join("\t"),
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
      if (window.appUnmark) window.appUnmark(button);
    }
  }

  async function handleCopyTable(button) {
    var selector = button.getAttribute("data-copy-table");
    var text = tableAsText(selector);
    try {
      if (!text.trim()) {
        toast("No rows to copy", "err");
        return;
      }
      await copyText(text);
      toast("Copied " + (text.split("\n").length - 1) + " error(s)");
    } catch (err) {
      toast("Copy failed", "err");
    } finally {
      if (window.appUnmark) window.appUnmark(button);
    }
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
    var tableBtn = target.closest("[data-copy-table]");
    if (tableBtn) {
      event.preventDefault();
      void handleCopyTable(tableBtn);
      return;
    }
    var liveBtn = target.closest("[data-live-toggle]");
    if (liveBtn) {
      // The global busy handler disables .btn in the capture phase; a genuinely
      // disabled button never dispatches a click, so no guard is needed here.
      event.preventDefault();
      var which = liveBtn.getAttribute("data-live-toggle");
      var viewer = document.getElementById("logViewer");
      var cards = document.getElementById("errorCards");
      if (which === "log" && viewer) {
        manualPause.log = viewer.dataset.live === "1";
        setLogLive(viewer.dataset.live !== "1");
      }
      if (which === "errors" && cards) {
        manualPause.errors = cards.dataset.live === "1";
        setErrorsLive(cards.dataset.live !== "1");
      }
      if (window.appUnmark) window.appUnmark(liveBtn);
    }
  });


  var viewer = document.getElementById("logViewer");
  if (viewer) {
    var runId = Number(viewer.dataset.run);
    var lastId = Number(viewer.dataset.lastId || "0");
    var logTimer = null;

    function appendEntries(htmlStrings) {
      if (!htmlStrings || !htmlStrings.length) return;
      var wasNearBottom = nearBottom(viewer);
      var current = viewer.children.length;
      if (current + htmlStrings.length > 1500) {
        var remove = current + htmlStrings.length - 1500;
        for (var i = 0; i < remove && viewer.firstChild; i++) {
          viewer.removeChild(viewer.firstChild);
        }
      }
      var frag = document.createDocumentFragment();
      htmlStrings.forEach(function (html) {
        var wrap = document.createElement("div");
        wrap.innerHTML = html;
        while (wrap.firstChild) frag.appendChild(wrap.firstChild);
      });
      viewer.appendChild(frag);
      if (wasNearBottom) viewer.scrollTop = viewer.scrollHeight;
    }

    function markFinished() {
      var pill = document.getElementById("livePill");
      if (pill) {
        pill.className = "pill ok";
        pill.textContent = "Finished";
      }
      var note = document.getElementById("liveNote");
      if (note) note.textContent = "session finished \u2014 log is complete";
    }

    var pollLog = function () {
      if (viewer.dataset.live !== "1" || document.hidden) return;
      var url = "/logs/fragment?run=" + runId + "&after=" + lastId;
      fetch(url, { credentials: "same-origin", cache: "no-store" })
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (data) {
          if (!data) return;
          if (viewer.dataset.live === "1") {
            if (data.entries && data.entries.length) appendEntries(data.entries);
            if (typeof data.lastId === "number" && data.lastId > 0) lastId = data.lastId;
          }
          if (data.finishedAt) markFinished();
        })
        .catch(function () {
          /* transient network error; retry on the next tick */
        });
    };

    setLogLive = function (on) {
      viewer.dataset.live = on ? "1" : "0";
      syncToggle("log", on);
      var note = document.getElementById("liveNote");
      if (note) {
        note.textContent = on
          ? "polling 2s \u2014 scroll up to pause"
          : "paused \u2014 scroll to the bottom to resume";
      }
      if (on) {
        if (!logTimer) logTimer = window.setInterval(pollLog, 2000);
        pollLog();
      } else if (logTimer) {
        window.clearInterval(logTimer);
        logTimer = null;
      }
    };

    viewer.addEventListener("scroll", function () {
      if (viewer.dataset.live === "1" && !nearBottom(viewer)) setLogLive(false);
      else if (
        viewer.dataset.live === "0" &&
        !manualPause.log &&
        nearBottom(viewer)
      ) setLogLive(true);
    });
    if (viewer.dataset.live === "1") setLogLive(true);
  }


  var errorCards = document.getElementById("errorCards");
  if (errorCards) {
    var errorsTimer = null;

    var pollErrors = function () {
      if (errorCards.dataset.live !== "1" || document.hidden) return;
      fetch("/errors/fragment", {
        credentials: "same-origin",
        cache: "no-store",
      })
        .then(function (response) {
          if (!response.ok) return null;
          var live = response.headers.get("X-Engine-Live") !== "0";
          return response.text().then(function (html) {
            return { html: html, live: live };
          });
        })
        .then(function (payload) {
          if (!payload) return;
          if (errorCards.dataset.live === "1") {
            var atBottom = nearBottom(errorCards);
            var top = errorCards.scrollTop;
            window.appMorph(errorCards, payload.html);
            errorCards.scrollTop = atBottom ? errorCards.scrollHeight : top;
          }
          if (!payload.live) {
            var pill = document.getElementById("livePill");
            if (pill) {
              pill.className = "pill ok";
              pill.textContent = "finished";
            }
          }
        })
        .catch(function () {
          /* transient network error; retry on the next tick */
        });
    };

    setErrorsLive = function (on) {
      errorCards.dataset.live = on ? "1" : "0";
      syncToggle("errors", on);
      var pill = document.getElementById("livePill");
      if (pill) {
        pill.className = on ? "pill warn" : "pill";
        pill.textContent = on ? "live" : "paused";
      }
      if (on) {
        if (!errorsTimer) errorsTimer = window.setInterval(pollErrors, 3000);
        pollErrors();
      } else if (errorsTimer) {
        window.clearInterval(errorsTimer);
        errorsTimer = null;
      }
    };

    errorCards.addEventListener("scroll", function () {
      if (errorCards.dataset.live === "1" && !nearBottom(errorCards)) setErrorsLive(false);
      else if (
        errorCards.dataset.live === "0" &&
        !manualPause.errors &&
        nearBottom(errorCards)
      ) setErrorsLive(true);
    });
    if (errorCards.dataset.live === "1") setErrorsLive(true);
  }
})();
