/* HOST Dispatcher Simulator: user interface.
   Reads the job list and system settings, runs HostDispatcher.simulate() and draws the results. */
(function () {
  "use strict";

  var H = window.HostDispatcher;
  var EMBED = !!window.__HOST_EMBED__;           // true when shown inside a viewer that cannot print or download
  var FIELDS = H.FIELDS;                          // arrival, priority, cpu, mbytes, printers, scanners, modems, cds
  var DEV_FIELDS = ["printers", "scanners", "modems", "cds"];
  var TYPE_NAME = { 0: "Real-time", 1: "User", 2: "User", 3: "User" };

  var state = { jobs: [], cfg: null, tick: 0, result: null, timer: null };

  function $(id) { return document.getElementById(id); }

  function h(tag, props) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k === "html") e.innerHTML = v;
      else if (k === "style") e.setAttribute("style", v);
      else e.setAttribute(k, v === true ? "" : v);
    });
    function add(c) {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) { c.forEach(add); return; }
      e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    for (var i = 2; i < arguments.length; i++) add(arguments[i]);
    return e;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function jc(id) { return "jc" + (id % 8); }
  function chip(id) { return h("span", { class: "chip " + jc(id), text: "P" + id }); }
  function fmt(n) { return H.fixed2(n); }

  /* ---------------- settings ---------------- */

  function defaultCfg() {
    return {
      userMem: H.DEFAULT_CONFIG.userMem, rtMem: H.DEFAULT_CONFIG.rtMem, policy: H.DEFAULT_CONFIG.policy,
      aging: H.DEFAULT_CONFIG.aging,
      devices: Object.assign({}, H.DEFAULT_CONFIG.devices),
    };
  }

  function num(input) {
    var s = input.value.trim();
    return s === "" ? NaN : Number(s);
  }

  /* ---------------- job table ---------------- */

  function buildRow(i) {
    var j = state.jobs[i];
    var tr = h("tr", { class: "job" + (j.priority === 0 ? " rt" : ""), "data-row": i });
    tr.appendChild(h("td", { class: "id", text: "P" + i }));

    FIELDS.forEach(function (f) {
      var td = h("td");
      var ctl;
      if (f === "priority") {
        ctl = h("select", { id: "j" + i + "_" + f, "aria-label": "Priority of P" + i });
        [0, 1, 2, 3].forEach(function (p) {
          ctl.appendChild(h("option", { value: p, text: p === 0 ? "0 RT" : String(p) }));
        });
        ctl.value = String(j.priority);
      } else {
        ctl = h("input", {
          id: "j" + i + "_" + f, type: "number", step: 1, inputmode: "numeric",
          min: f === "cpu" || f === "mbytes" ? 1 : 0,
          "aria-label": ({ arrival: "Arrival", cpu: "CPU seconds", mbytes: "Memory MB", printers: "Printers",
                           scanners: "Scanners", modems: "Modems", cds: "CD drives" })[f] + " of P" + i,
        });
        ctl.value = Number.isNaN(j[f]) ? "" : j[f];
        if (j.priority === 0 && DEV_FIELDS.indexOf(f) >= 0) ctl.disabled = true;
      }
      ctl.dataset.row = i; ctl.dataset.field = f;
      td.appendChild(ctl);
      tr.appendChild(td);
    });

    var del = h("button", { type: "button", "aria-label": "Remove P" + i, title: "Remove", text: "×" });
    del.dataset.row = i;
    del.addEventListener("click", function () { state.jobs.splice(i, 1); renderJobs(); run(); });
    tr.appendChild(h("td", { class: "del" }, del));

    var err = h("tr", { class: "err", hidden: true, "data-err": i }, h("td", { colspan: 10 }));
    return [tr, err];
  }

  function renderJobs() {
    var body = $("jobsBody");
    clear(body);
    state.jobs.forEach(function (_, i) {
      buildRow(i).forEach(function (r) { body.appendChild(r); });
    });
  }

  function onJobInput(e) {
    var t = e.target;
    if (t.dataset.row === undefined) return;
    var i = Number(t.dataset.row), f = t.dataset.field;
    var v = t.tagName === "SELECT" ? Number(t.value) : num(t);
    state.jobs[i][f] = v;
    if (f === "priority") {
      var row = t.closest("tr");
      row.classList.toggle("rt", v === 0);
      DEV_FIELDS.forEach(function (d) {
        var c = $("j" + i + "_" + d);
        if (v === 0) { state.jobs[i][d] = 0; c.value = 0; c.disabled = true; } else c.disabled = false;
      });
    }
    run();
  }

  /* ---------------- starting state and pasted lists ---------------- */

  function start() {
    state.jobs = [{ arrival: 0, priority: 1, cpu: 3, mbytes: 64, printers: 0, scanners: 0, modems: 0, cds: 0 }];
    state.cfg = defaultCfg();
    writeCfg();
    renderJobs();
    state.tick = 0;
    run();
  }

  function loadPasted() {
    var parsed = H.parseJobs($("pasteText").value);
    var err = $("pasteErr");
    if (parsed.errors.length) {
      err.hidden = false;
      err.textContent = parsed.errors.slice(0, 3).join(" ");
      return;
    }
    if (!parsed.jobs.length) { err.hidden = false; err.textContent = "Paste at least one job."; return; }
    err.hidden = true;
    state.jobs = parsed.jobs.slice(0, H.MAXJOBS);
    state.tick = 0;
    renderJobs();
    run();
  }

  function writeCfg() {
    $("userMem").value = state.cfg.userMem;
    $("rtMem").value = state.cfg.rtMem;
    $("policy").value = state.cfg.policy;
    $("aging").value = state.cfg.aging;
    DEV_FIELDS.forEach(function (d) { $("dev_" + d).value = state.cfg.devices[d]; });
  }

  function onCfgInput(e) {
    var id = e.target.id;
    if (id === "policy") state.cfg.policy = e.target.value;
    else if (id === "userMem") state.cfg.userMem = num(e.target);
    else if (id === "rtMem") state.cfg.rtMem = num(e.target);
    else if (id === "aging") state.cfg.aging = num(e.target);
    else if (id.indexOf("dev_") === 0) state.cfg.devices[id.slice(4)] = num(e.target);
    run();
  }

  /* ---------------- running ---------------- */

  function run() {
    stopPlay();
    var empty = state.jobs.length === 0;
    var res = empty ? { ok: false, errors: [] } : H.simulate(state.jobs, state.cfg);
    state.result = res;
    markErrors(res);
    var ok = res.ok;
    $("resultBody").hidden = !ok;
    $("errorBox").hidden = ok || empty;
    $("emptyBox").hidden = !empty;
    ["btnPrint", "btnDownload", "btnCopy"].forEach(function (id) { $(id).disabled = !ok; });
    if (!ok) { if (!empty) renderErrorBox(res.errors); $("status").textContent = ""; renderPrintInputs(null); return; }

    $("status").textContent = res.header.replace("HOST dispatcher: ", "") + ". Finished at second " + res.summary.lastTick + ".";
    if (state.tick > res.shownTicks) state.tick = res.shownTicks;
    renderSummary(res);
    renderTrace(res);
    renderStats(res);
    renderLog(res);
    renderStep();
    renderPrintInputs(res);
    var full = H.formatText(res);
    var lines = full.split("\n");
    $("plainText").value = lines.length > 3000
      ? lines.slice(0, 3000).join("\n") + "\n... (" + (lines.length - 3000) + " more lines. Download .txt or Copy as text has everything.)"
      : full;
  }

  function markErrors(res) {
    var bads = document.querySelectorAll(".bad");
    Array.prototype.forEach.call(bads, function (n) { n.classList.remove("bad"); n.removeAttribute("aria-invalid"); });
    Array.prototype.forEach.call(document.querySelectorAll("tr.err"), function (r) { r.hidden = true; });
    if (res.ok) return;
    res.errors.forEach(function (e) {
      var target = e.row >= 0 ? $("j" + e.row + "_" + e.field) : $(e.field);
      if (target) { target.classList.add("bad"); target.setAttribute("aria-invalid", "true"); }
      if (e.row >= 0) {
        var r = document.querySelector('tr[data-err="' + e.row + '"]');
        if (r) { r.hidden = false; r.firstChild.textContent = e.message; }
      }
    });
  }

  function renderErrorBox(errors) {
    var box = $("errorBox");
    clear(box);
    box.appendChild(h("strong", { text: "Fix these to see the results:" }));
    var ul = h("ul");
    errors.forEach(function (e) {
      ul.appendChild(h("li", { text: (e.row >= 0 ? "P" + e.row + ": " : "") + e.message }));
    });
    box.appendChild(ul);
  }

  /* ---------------- results ---------------- */

  function renderSummary(res) {
    var s = res.summary, dl = $("summary");
    clear(dl);
    function item(label, value, unit) {
      dl.appendChild(h("div", null, h("dt", { text: label }), h("dd", null, value, unit ? h("small", { text: " " + unit }) : null)));
    }
    item("Average turnaround", fmt(s.avgTurnaround), "s");
    item("Average waiting", fmt(s.avgWaiting), "s");
    item("Finished at", String(s.lastTick), "s");
    item("CPU idle", String(s.idleSeconds), "s of " + s.lastTick);
  }

  function stateClass(cell) {
    var c = cell.charAt(cell.length - 1);
    return c === "|" ? "sD" : "s" + c;
  }

  function renderTrace(res) {
    var tb = $("trace");
    clear(tb);
    var thead = h("thead"), hr = h("tr");
    hr.appendChild(h("th", { class: "rowh", scope: "col", text: "T =" }));
    for (var t = 0; t <= res.shownTicks; t++) {
      var th = h("th", { scope: "col", role: "button", tabindex: 0, text: String(t), "data-t": t, title: "Show the state at second " + t });
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    tb.appendChild(thead);
    var body = h("tbody");
    res.trace.forEach(function (row, i) {
      var tr = h("tr");
      tr.appendChild(h("th", { class: "rowh", scope: "row", text: "P" + i }));
      row.forEach(function (cell, t) {
        tr.appendChild(h("td", { class: cell ? stateClass(cell) : "", "data-t": t, text: cell }));
      });
      body.appendChild(tr);
    });
    tb.appendChild(body);
    var note = $("traceNote");
    note.hidden = res.summary.lastTick <= res.shownTicks;
    note.textContent = "The run lasts " + res.summary.lastTick + " seconds. The trace and the second-by-second view show the first " +
      (res.shownTicks + 1) + " seconds. The job times, averages and event log cover the whole run.";
    renderPrintTrace(res);
    highlightTick();
  }

  function renderPrintTrace(res) {
    var box = $("printTrace");
    clear(box);
    if (res.summary.lastTick > H.TRACE_TEXT_MAX) {
      box.appendChild(h("p", { text: "The trace is not printed for runs longer than " + H.TRACE_TEXT_MAX + " seconds. See the job times below." }));
      return;
    }
    var CH = 26;
    for (var from = 0; from <= res.summary.lastTick; from += CH) {
      var to = Math.min(res.summary.lastTick, from + CH - 1);
      var tb = h("table");
      var hr = h("tr", null, h("th", { text: "T =" }));
      for (var t = from; t <= to; t++) hr.appendChild(h("th", { text: String(t) }));
      tb.appendChild(h("thead", null, hr));
      var body = h("tbody");
      res.trace.forEach(function (row, i) {
        var tr = h("tr", null, h("th", { text: "P" + i }));
        for (var t2 = from; t2 <= to; t2++) tr.appendChild(h("td", { class: row[t2] ? stateClass(row[t2]) : "", text: row[t2] }));
        body.appendChild(tr);
      });
      tb.appendChild(body);
      box.appendChild(tb);
    }
  }

  function highlightTick() {
    Array.prototype.forEach.call(document.querySelectorAll("#trace .sel, #log .sel"), function (n) { n.classList.remove("sel"); });
    Array.prototype.forEach.call(document.querySelectorAll('#trace [data-t="' + state.tick + '"]'), function (n) { n.classList.add("sel"); });
    Array.prototype.forEach.call(document.querySelectorAll('#log li[data-t="' + state.tick + '"]'), function (n) { n.classList.add("sel"); });
  }

  function renderStats(res) {
    var tb = $("stats");
    clear(tb);
    tb.appendChild(h("thead", null, h("tr", null,
      ["Job", "Type", "Arrival", "CPU", "First ran", "Finish", "Turnaround", "Waiting"].map(function (x) { return h("th", { scope: "col", text: x }); }))));
    var body = h("tbody");
    res.stats.forEach(function (s) {
      body.appendChild(h("tr", null,
        h("td", { text: "P" + s.id }),
        h("td", { text: TYPE_NAME[s.priority] + (s.priority ? " (" + s.priority + ")" : "") }),
        h("td", { class: "num", text: s.arrival }), h("td", { class: "num", text: s.cpu }),
        h("td", { class: "num", text: s.firstRun }), h("td", { class: "num", text: s.finish }),
        h("td", { class: "num", text: s.turnaround }), h("td", { class: "num", text: s.waiting })));
    });
    tb.appendChild(body);
    var sm = res.summary;
    tb.appendChild(h("tfoot", null, h("tr", null,
      h("td", { text: "Average" }), h("td"), h("td"), h("td"), h("td"), h("td"),
      h("td", { class: "num", text: fmt(sm.avgTurnaround) }), h("td", { class: "num", text: fmt(sm.avgWaiting) }))));
  }

  function renderLog(res) {
    var ol = $("log");
    clear(ol);
    var LOGMAX = 500, ln = $("logNote");
    ln.hidden = res.events.length <= LOGMAX;
    ln.textContent = "Showing the first " + LOGMAX + " of " + res.events.length + " events. Download .txt or Copy as text has all of them.";
    res.events.slice(0, LOGMAX).forEach(function (e) {
      var msg = h("span", { class: "m" });
      var m = /^P(\d+)(.*)$/.exec(e.text);
      if (m) { msg.appendChild(h("strong", { text: "P" + m[1] })); msg.appendChild(document.createTextNode(m[2])); }
      else msg.textContent = e.text;
      ol.appendChild(h("li", { "data-t": e.t },
        h("span", { class: "t", text: "T=" + e.t }), h("span", { class: "k", text: e.kind }), msg));
    });
    if (!res.events.length) ol.appendChild(h("li", null, h("span"), h("span"), h("span", { class: "m", text: "No events." })));
  }

  /* ---------------- step-through view ---------------- */

  function queueLine(name, ids) {
    var items = h("div", { class: "qi" });
    if (ids.length) ids.forEach(function (id) { items.appendChild(chip(id)); });
    else items.appendChild(h("span", { class: "none", text: "empty" }));
    return h("div", { class: "q" }, h("span", { class: "qn", text: name }), items);
  }

  function memBar(blocks, total, small) {
    var bar = h("div", { class: "membar" + (small ? " small" : ""), role: "img",
      "aria-label": blocks.map(function (b) { return (b.allocated ? "P" + b.owner : "free") + " " + b.size + " MB"; }).join(", ") });
    blocks.forEach(function (b) {
      var share = b.size / total;
      var seg = h("div", { class: "seg " + (b.allocated ? "used " + jc(b.owner) : "free"),
        style: "flex: " + b.size + " 1 0", title: (b.allocated ? "P" + b.owner : "Free") + ": " + b.size + " MB at offset " + b.offset });
      if (share >= 0.05 || (small && share >= 0.12)) {
        seg.appendChild(document.createTextNode(b.allocated ? "P" + b.owner : "free"));
        if (!small && share >= 0.09) seg.appendChild(h("small", { text: b.size + " MB" }));
      }
      bar.appendChild(seg);
    });
    return bar;
  }

  function renderStep() {
    var res = state.result;
    if (!res || !res.ok) return;
    var snap = res.snapshots[state.tick];
    var last = res.shownTicks;
    $("stepT").textContent = state.tick;
    var range = $("stepRange");
    range.max = last; range.value = state.tick;
    $("stepPrev").disabled = state.tick <= 0;
    $("stepNext").disabled = state.tick >= last;

    var q = $("queues");
    clear(q);
    q.appendChild(queueLine("CPU running", snap.running === null ? [] : [snap.running]));
    q.appendChild(queueLine("Real-time queue", snap.rt));
    q.appendChild(queueLine("User queue (waiting)", snap.user));
    for (var i = 0; i < 3; i++) q.appendChild(queueLine("Feedback queue " + i, snap.fb[i]));

    var mv = $("memView");
    clear(mv);
    var total = res.config.userMem;
    mv.appendChild(memBar(snap.mem, total, false));
    mv.appendChild(h("div", { class: "scale" }, h("span", { text: "0" }), h("span", { text: total + " MB" })));
    var tbl = h("table", { class: "blocks" });
    tbl.appendChild(h("thead", null, h("tr", null, h("th", { text: "Offset" }), h("th", { text: "Size" }), h("th", { text: "Used by" }))));
    var tb = h("tbody");
    snap.mem.forEach(function (b) {
      tb.appendChild(h("tr", null, h("td", { text: b.offset + "–" + (b.offset + b.size) }),
        h("td", { text: b.size + " MB" }), h("td", { text: b.allocated ? "P" + b.owner : "free" })));
    });
    tbl.appendChild(tb);
    mv.appendChild(tbl);
    var rt = snap.rtmem.filter(function (b) { return b.allocated; });
    mv.appendChild(h("p", { class: "rtline" }, "Real-time memory (" + res.config.rtMem + " MB):",
      rt.length ? chip(rt[0].owner) : h("span", { text: "free" })));

    var a = snap.avail, c = res.config.devices;
    $("devView").textContent = "Printers " + a.printers + "/" + c.printers + "   Scanners " + a.scanners + "/" + c.scanners +
      "   Modems " + a.modems + "/" + c.modems + "   CD drives " + a.cds + "/" + c.cds;
    highlightTick();
  }

  function setTick(t) {
    if (!state.result || !state.result.ok) return;
    state.tick = Math.max(0, Math.min(state.result.shownTicks, t));
    renderStep();
  }

  function stopPlay() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    var b = $("stepPlay");
    if (b) b.textContent = "Play";
  }

  function togglePlay() {
    if (state.timer) { stopPlay(); return; }
    var res = state.result;
    if (!res || !res.ok) return;
    if (state.tick >= res.shownTicks) setTick(0);
    $("stepPlay").textContent = "Pause";
    state.timer = setInterval(function () {
      if (state.tick >= res.shownTicks) { stopPlay(); return; }
      setTick(state.tick + 1);
    }, 800);
  }

  /* ---------------- print layout (paper only) ---------------- */

  function renderPrintInputs(res) {
    var box = $("printInputs");
    clear(box);
    if (!res) return;
    var c = res.config;
    box.appendChild(h("p", null, "HOST Dispatcher Simulator"));
    box.appendChild(h("h3", { text: "Settings used" }));
    box.appendChild(h("p", { text: "User memory " + c.userMem + " MB, real-time memory " + c.rtMem + " MB, " +
      H.POLICY_NAMES[c.policy].toLowerCase() + ". Devices: " + c.devices.printers + " printers, " + c.devices.scanners +
      " scanners, " + c.devices.modems + " modems, " + c.devices.cds + " CD drives. Three feedback queues, 1 second turn, " +
      (c.aging > 0 ? "aging after " + c.aging + " seconds of waiting." : "no aging.") }));
    box.appendChild(h("h3", { text: "Job list" }));
    var tb = h("table");
    tb.appendChild(h("thead", null, h("tr", null, ["Job", "Arrival", "Priority", "CPU", "Memory MB", "Printers", "Scanners", "Modems", "CDs"]
      .map(function (x) { return h("th", { text: x }); }))));
    var body = h("tbody");
    res.jobs.forEach(function (j, i) {
      body.appendChild(h("tr", null, h("td", { text: "P" + i }), FIELDS.map(function (f) { return h("td", { text: j[f] }); })));
    });
    tb.appendChild(body);
    box.appendChild(tb);
  }

  /* ---------------- actions ---------------- */

  function textOut() { return state.result && state.result.ok ? H.formatText(state.result) : ""; }

  function flash(msg) {
    var s = $("status");
    var keep = s.textContent;
    s.textContent = msg;
    setTimeout(function () { if (s.textContent === msg) s.textContent = keep; }, 2200);
  }

  function copyText() {
    var text = textOut();
    if (!text) return;
    function fallback() {
      var d = $("plain");
      d.open = true;
      var ta = $("plainText");
      ta.focus(); ta.select();
      flash("Copy was blocked. The text is selected below, press Ctrl+C.");
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { flash("Copied."); }, fallback);
      } else fallback();
    } catch (e) { fallback(); }
  }

  function downloadText() {
    var text = textOut();
    if (!text) return;
    var blob = new Blob([text + "\n"], { type: "text/plain" });
    var a = h("a", { href: URL.createObjectURL(blob), download: "host-dispatcher-results.txt" });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ---------------- start ---------------- */

  function init() {
    if (EMBED) Array.prototype.forEach.call(document.querySelectorAll("[data-web-only]"), function (n) { n.hidden = true; });

    var pol = $("policy");
    Object.keys(H.POLICY_NAMES).forEach(function (k) { pol.appendChild(h("option", { value: k, text: H.POLICY_NAMES[k] })); });

    $("jobsBody").addEventListener("input", onJobInput);
    ["userMem", "rtMem", "policy", "aging", "dev_printers", "dev_scanners", "dev_modems", "dev_cds"].forEach(function (id) {
      $(id).addEventListener("input", onCfgInput);
    });
    $("pasteLoad").addEventListener("click", loadPasted);

    $("addJob").addEventListener("click", function () {
      if (state.jobs.length >= H.MAXJOBS) return;
      var lastJob = state.jobs[state.jobs.length - 1];
      state.jobs.push({
        arrival: lastJob && isFinite(lastJob.arrival) ? lastJob.arrival : 0, priority: 1, cpu: 2, mbytes: 64,
        printers: 0, scanners: 0, modems: 0, cds: 0,
      });
      renderJobs(); run();
      var f = $("j" + (state.jobs.length - 1) + "_arrival");
      if (f) f.focus();
    });
    $("sortJobs").addEventListener("click", function () {
      state.jobs = state.jobs.map(function (j, i) { return { j: j, i: i }; })
        .sort(function (a, b) { return (a.j.arrival - b.j.arrival) || (a.i - b.i); })
        .map(function (x) { return x.j; });
      renderJobs(); run();
    });
    $("clearJobs").addEventListener("click", function () { state.jobs = []; renderJobs(); run(); });

    $("btnPrint").addEventListener("click", function () { window.print(); });
    $("btnDownload").addEventListener("click", downloadText);
    $("btnCopy").addEventListener("click", copyText);

    $("stepPrev").addEventListener("click", function () { stopPlay(); setTick(state.tick - 1); });
    $("stepNext").addEventListener("click", function () { stopPlay(); setTick(state.tick + 1); });
    $("stepRange").addEventListener("input", function (e) { stopPlay(); setTick(Number(e.target.value)); });
    $("stepPlay").addEventListener("click", togglePlay);

    $("trace").addEventListener("click", function (e) {
      var th = e.target.closest("th[data-t]");
      if (th) { stopPlay(); setTick(Number(th.dataset.t)); }
    });
    $("trace").addEventListener("keydown", function (e) {
      if ((e.key === "Enter" || e.key === " ") && e.target.matches("th[data-t]")) {
        e.preventDefault(); stopPlay(); setTick(Number(e.target.dataset.t));
      }
    });

    start();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
