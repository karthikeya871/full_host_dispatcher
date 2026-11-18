/*
 * HOST dispatcher engine (JavaScript port of c-implementation/host.c).
 *
 * Same algorithm, step for step:
 *   i.   arrivals      input queue  -> real-time queue or user job queue
 *   ii.  admission     user job queue -> feedback queue, only if memory AND
 *                      all I/O devices are available (FIFO, head of queue only)
 *        aging         optional: a job waiting too long in queue 1 or 2 goes back to queue 0
 *   iii. running job   decrement remaining time; terminate or suspend + demote
 *   iv.  dispatch      real-time queue first, then highest non-empty feedback queue
 *
 * Works in the browser (window.HostDispatcher) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HostDispatcher = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var N_FEEDBACK = 3;
  var MAXTICKS = 200000;       // longest run, in seconds
  var DISPLAY_TICKS = 400;     // the trace and the second-by-second view keep only the first 400 seconds
  var TRACE_TEXT_MAX = 200;    // the plain-text trace is printed only for runs up to 200 seconds
  var MAXJOBS = 128;

  var DEFAULT_CONFIG = {
    userMem: 960,          // MB for user jobs
    rtMem: 64,             // MB reserved for real-time jobs
    policy: "first",       // first | next | best | worst
    aging: 0,              // seconds a job may wait in queue 1 or 2 before it is moved back to queue 0 (0 = off)
    devices: { printers: 2, scanners: 1, modems: 1, cds: 2 },
  };

  var POLICY_NAMES = { first: "First fit", next: "Next fit", best: "Best fit", worst: "Worst fit" };

  /* ---------------- memory manager (port of mab.c) ---------------- */

  function memInit(size, policy) {
    var m = { offset: 0, size: size, allocated: false, owner: null, prev: null, next: null };
    return { head: m, rover: m, policy: policy, size: size };
  }

  function memChk(a, size) {
    var m, pick = null;
    if (size <= 0) return null;
    switch (a.policy) {
      case "first":
        for (m = a.head; m; m = m.next) if (!m.allocated && m.size >= size) return m;
        return null;
      case "next": {
        var start = a.rover || a.head;
        m = start;
        do {
          if (!m.allocated && m.size >= size) return m;
          m = m.next ? m.next : a.head;
        } while (m !== start);
        return null;
      }
      case "best":
        for (m = a.head; m; m = m.next)
          if (!m.allocated && m.size >= size && (!pick || m.size < pick.size)) pick = m;
        return pick;
      case "worst":
        for (m = a.head; m; m = m.next)
          if (!m.allocated && m.size >= size && (!pick || m.size > pick.size)) pick = m;
        return pick;
    }
    return null;
  }

  function memSplit(m, size) {
    if (m.size > size) {
      var rest = { offset: m.offset + size, size: m.size - size, allocated: false, owner: null, prev: m, next: m.next };
      if (m.next) m.next.prev = rest;
      m.next = rest;
      m.size = size;
    }
    return m;
  }

  function memAlloc(a, size) {
    var m = memChk(a, size);
    if (!m) return null;
    memSplit(m, size);
    m.allocated = true;
    a.rover = m.next ? m.next : a.head;
    return m;
  }

  function memMerge(a, m) {
    var n = m.next;
    if (n && !m.allocated && !n.allocated) {
      m.size += n.size;
      m.next = n.next;
      if (n.next) n.next.prev = m;
      if (a.rover === n) a.rover = m;
    }
    return m;
  }

  function memFree(a, m) {
    m.allocated = false;
    m.owner = null;
    memMerge(a, m);
    if (m.prev && !m.prev.allocated) m = memMerge(a, m.prev);
    return m;
  }

  function memBlocks(a) {
    var out = [];
    for (var m = a.head; m; m = m.next)
      out.push({ offset: m.offset, size: m.size, allocated: m.allocated, owner: m.owner });
    return out;
  }

  /* ---------------- input checking (port of loadJobs) ---------------- */

  var FIELDS = ["arrival", "priority", "cpu", "mbytes", "printers", "scanners", "modems", "cds"];

  function isInt(v) { return typeof v === "number" && isFinite(v) && Math.floor(v) === v; }

  function validate(jobs, cfg) {
    var errors = [];
    function add(row, field, message) { errors.push({ row: row, field: field, message: message }); }

    if (!isInt(cfg.userMem) || cfg.userMem <= 0) add(-1, "userMem", "User memory must be a whole number above 0.");
    if (!isInt(cfg.rtMem) || cfg.rtMem < 0) add(-1, "rtMem", "Real-time memory must be a whole number, 0 or more.");
    ["printers", "scanners", "modems", "cds"].forEach(function (k) {
      if (!isInt(cfg.devices[k]) || cfg.devices[k] < 0) add(-1, "dev_" + k, "Device totals must be whole numbers, 0 or more.");
    });
    if (!POLICY_NAMES[cfg.policy]) add(-1, "policy", "Unknown memory policy.");
    if (!isInt(cfg.aging) || cfg.aging < 0) add(-1, "aging", "Aging must be a whole number, 0 (off) or more.");
    if (jobs.length === 0) { add(-1, "jobs", "Add at least one job."); return errors; }
    if (jobs.length > MAXJOBS) add(-1, "jobs", "At most " + MAXJOBS + " jobs.");

    var last = 0;
    jobs.forEach(function (j, i) {
      var bad = FIELDS.filter(function (f) { return !isInt(j[f]); });
      if (bad.length) { add(i, bad[0], "Every value must be a whole number."); return; }
      if (j.arrival < last) add(i, "arrival", "Arrival times must not decrease down the list (use Sort by arrival).");
      if (j.arrival < 0 || j.priority < 0 || j.priority > 3 || j.cpu <= 0 || j.mbytes <= 0 ||
          j.printers < 0 || j.scanners < 0 || j.modems < 0 || j.cds < 0) {
        if (j.arrival < 0) add(i, "arrival", "Arrival cannot be negative.");
        else if (j.priority < 0 || j.priority > 3) add(i, "priority", "Priority must be 0 (real-time) to 3.");
        else if (j.cpu <= 0) add(i, "cpu", "CPU time must be at least 1.");
        else if (j.mbytes <= 0) add(i, "mbytes", "Memory must be at least 1 MB.");
        else add(i, "printers", "Device counts cannot be negative.");
      } else if (j.priority === 0) {
        if (j.mbytes > cfg.rtMem) add(i, "mbytes", "Real-time job needs more than the " + cfg.rtMem + " MB real-time memory.");
        else if (j.printers || j.scanners || j.modems || j.cds) add(i, "printers", "Real-time jobs cannot use I/O devices.");
      } else {
        if (j.mbytes > cfg.userMem) add(i, "mbytes", "Job needs more memory than the " + cfg.userMem + " MB user memory.");
        else if (j.printers > cfg.devices.printers || j.scanners > cfg.devices.scanners ||
                 j.modems > cfg.devices.modems || j.cds > cfg.devices.cds)
          add(i, "printers", "Job needs more devices than the system has.");
      }
      last = Math.max(last, j.arrival);
    });
    return errors;
  }

  /* ---------------- the dispatcher (port of main in host.c) ---------------- */

  function simulate(jobsIn, cfgIn) {
    var cfg = {
      userMem: DEFAULT_CONFIG.userMem, rtMem: DEFAULT_CONFIG.rtMem, policy: DEFAULT_CONFIG.policy,
      aging: DEFAULT_CONFIG.aging,
      devices: Object.assign({}, DEFAULT_CONFIG.devices),
    };
    if (cfgIn) {
      ["userMem", "rtMem", "policy", "aging"].forEach(function (k) { if (cfgIn[k] !== undefined) cfg[k] = cfgIn[k]; });
      if (cfgIn.devices) Object.assign(cfg.devices, cfgIn.devices);
    }

    var errors = validate(jobsIn, cfg);
    if (errors.length) return { ok: false, errors: errors };

    var jobs = jobsIn.map(function (j, i) {
      return {
        id: i, arrival: j.arrival, priority: j.priority, cpu: j.cpu, remaining: j.cpu,
        mbytes: j.mbytes, printers: j.printers, scanners: j.scanners, modems: j.modems, cds: j.cds,
        level: 0, queuedAt: 0, started: false, finish: -1, firstRun: -1, state: "new", mem: null,
      };
    });

    var inputQ = jobs.slice(), rtQ = [], userQ = [], fbQ = [[], [], []];
    var userMem = memInit(cfg.userMem, cfg.policy);
    var rtMem = memInit(cfg.rtMem, "first");
    var avail = {
      printers: cfg.devices.printers, scanners: cfg.devices.scanners,
      modems: cfg.devices.modems, cds: cfg.devices.cds,
    };
    var running = null, T = 0;
    var cells = jobs.map(function () { return []; });
    var events = [], snapshots = [];

    function ev(p, c) { if (T < DISPLAY_TICKS) cells[p.id][T] = (cells[p.id][T] || "") + c; }
    function log(kind, jobId, text) { events.push({ t: T, kind: kind, job: jobId, text: text }); }
    function ids(q) { return q.map(function (p) { return p.id; }); }
    function fbNonEmpty() { return fbQ.some(function (q) { return q.length > 0; }); }
    function anyWaiting() { return rtQ.length > 0 || fbNonEmpty(); }
    function rsrcChk(p) {
      return p.printers <= avail.printers && p.scanners <= avail.scanners &&
             p.modems <= avail.modems && p.cds <= avail.cds;
    }
    function rsrcAlloc(p) { avail.printers -= p.printers; avail.scanners -= p.scanners; avail.modems -= p.modems; avail.cds -= p.cds; }
    function rsrcFree(p) { avail.printers += p.printers; avail.scanners += p.scanners; avail.modems += p.modems; avail.cds += p.cds; }

    for (T = 0; ; T++) {
      if (T >= MAXTICKS - 1) {
        return { ok: false, errors: [{ row: -1, field: "jobs", message: "The simulation runs longer than " + (MAXTICKS - 1) + " seconds. Reduce the CPU times." }] };
      }

      /* i. arrivals */
      while (inputQ.length && inputQ[0].arrival <= T) {
        var a = inputQ.shift();
        if (a.priority === 0) {
          a.state = "queued"; rtQ.push(a); ev(a, "Q");
          log("arrive", a.id, "P" + a.id + " arrived -> real-time queue");
        } else {
          a.state = "pending"; userQ.push(a); ev(a, "P");
          log("arrive", a.id, "P" + a.id + " arrived -> user job queue");
        }
      }

      /* ii. admission: head of the user queue only, memory AND devices */
      while (userQ.length) {
        var h = userQ[0];
        if (!memChk(userMem, h.mbytes) || !rsrcChk(h)) break;
        userQ.shift();
        h.mem = memAlloc(userMem, h.mbytes);
        h.mem.owner = h.id;
        rsrcAlloc(h);
        h.level = h.priority - 1;
        h.state = "queued";
        fbQ[h.level].push(h);
        h.queuedAt = T;
        ev(h, "F");
        log("admit", h.id, "P" + h.id + " admitted: " + h.mbytes + " MB at offset " + h.mem.offset +
            ", printers " + h.printers + " scanners " + h.scanners + " modems " + h.modems + " cds " + h.cds +
            " -> queue " + h.level);
      }

      /* aging: a job waiting too long in queue 1 or 2 goes back to the end of queue 0 */
      if (cfg.aging > 0) {
        for (var lvl = 1; lvl < N_FEEDBACK; lvl++) {
          var keep = [];
          fbQ[lvl].forEach(function (w) {
            if (T - w.queuedAt >= cfg.aging) {
              log("age", w.id, "P" + w.id + " aged -> queue 0 (waited " + (T - w.queuedAt) + " s)");
              w.level = 0; w.queuedAt = T; fbQ[0].push(w);
            } else keep.push(w);
          });
          fbQ[lvl] = keep;
        }
      }

      /* iii. the running job */
      if (running) {
        var r = running;
        r.remaining--;
        if (r.remaining <= 0) {
          r.state = "done"; r.finish = T; ev(r, "|");
          if (r.priority === 0) memFree(rtMem, r.mem);
          else { memFree(userMem, r.mem); rsrcFree(r); }
          r.mem = null;
          log("terminate", r.id, "P" + r.id + " terminated, memory and resources freed");
          running = null;
        } else if (r.priority !== 0 && anyWaiting()) {
          r.state = "suspended"; ev(r, "S");
          if (r.level < N_FEEDBACK - 1) r.level++;
          fbQ[r.level].push(r);
          r.queuedAt = T;
          log("suspend", r.id, "P" + r.id + " suspended -> queue " + r.level);
          running = null;
        }
      }

      /* iv. dispatch */
      if (!running) {
        var p = null;
        if (rtQ.length) p = rtQ.shift();
        else for (var i = 0; i < N_FEEDBACK && !p; i++) if (fbQ[i].length) p = fbQ[i].shift();
        if (p) {
          if (p.started) log("resume", p.id, "P" + p.id + " resumed");
          else {
            if (p.priority === 0) { p.mem = memAlloc(rtMem, p.mbytes); p.mem.owner = p.id; }
            p.started = true;
            if (p.firstRun < 0) p.firstRun = T;
            log("start", p.id, "P" + p.id + " started");
          }
          p.state = "running"; ev(p, "R");
          running = p;
        }
      }

      /* record: trace cell of every live job that had no event this tick */
      if (T < DISPLAY_TICKS) jobs.forEach(function (j) {
        if (cells[j.id][T] || j.state === "new" || j.state === "done") return;
        var ch = j.state === "pending" ? "P" : j.state === "queued" ? (j.priority === 0 ? "Q" : "F")
               : j.state === "running" ? "R" : j.state === "suspended" ? "S" : "";
        if (ch) cells[j.id][T] = ch;
      });

      if (T < DISPLAY_TICKS) snapshots.push({
        t: T,
        running: running ? running.id : null,
        rt: ids(rtQ), user: ids(userQ), fb: fbQ.map(ids),
        mem: memBlocks(userMem), rtmem: memBlocks(rtMem),
        avail: { printers: avail.printers, scanners: avail.scanners, modems: avail.modems, cds: avail.cds },
        remaining: jobs.map(function (j) { return j.remaining; }),
        states: jobs.map(function (j) { return j.state; }),
      });

      if (!(inputQ.length || userQ.length || rtQ.length || fbNonEmpty() || running)) break;
    }

    var last = T;
    var shown = Math.min(last, DISPLAY_TICKS - 1);        // last second kept in the trace and step view
    var trace = jobs.map(function (j) {
      var row = [];
      for (var t = 0; t <= shown; t++) row.push(cells[j.id][t] || "");
      return row;
    });

    var totalTurn = 0, totalWait = 0, totalCpu = 0;
    var stats = jobs.map(function (j) {
      var turn = j.finish - j.arrival, wait = turn - j.cpu;
      totalTurn += turn; totalWait += wait; totalCpu += j.cpu;
      return { id: j.id, arrival: j.arrival, priority: j.priority, cpu: j.cpu, firstRun: j.firstRun,
               finish: j.finish, turnaround: turn, waiting: wait };
    });
    var n = jobs.length;

    return {
      ok: true,
      config: cfg,
      jobs: jobsIn.map(function (j) { return Object.assign({}, j); }),
      header: "HOST dispatcher: " + n + " jobs, user memory " + cfg.userMem + " MB (" + cfg.policy +
              " fit), real-time memory " + cfg.rtMem + " MB" + (cfg.aging > 0 ? ", aging " + cfg.aging + " s" : ""),
      events: events,
      trace: trace,
      shownTicks: shown,
      snapshots: snapshots,
      stats: stats,
      summary: {
        jobs: n, lastTick: last,
        avgTurnaround: totalTurn / n, avgWaiting: totalWait / n,
        cpuSeconds: totalCpu, idleSeconds: last - totalCpu,
        utilization: last > 0 ? totalCpu / last : 1,
      },
    };
  }

  /* two decimals, rounding exact ties to even like C's printf (toFixed rounds them up) */
  function fixed2(x) {
    var e = x * 8;
    if (Math.floor(e) === e && e % 2 !== 0) {
      var s = x * 100, f = Math.floor(s);
      return ((f % 2 === 0 ? f : f + 1) / 100).toFixed(2);
    }
    return x.toFixed(2);
  }

  /* plain-text report in the same shape as the C program prints */
  function formatText(res) {
    if (!res.ok) return res.errors.map(function (e) { return e.message; }).join("\n");
    var out = [res.header];
    res.events.forEach(function (e) {
      var t = String(e.t); while (t.length < 2) t = " " + t;
      out.push("[T=" + t + "] " + e.text);
    });
    out.push("");
    if (res.summary.lastTick > TRACE_TEXT_MAX) {
      out.push("Execution trace omitted: the run is longer than " + TRACE_TEXT_MAX + " seconds.");
      out.push("");
      out.push("Average turnaround time: " + fixed2(res.summary.avgTurnaround) + " s, average waiting time: " +
               fixed2(res.summary.avgWaiting) + " s");
      return out.join("\n");
    }
    out.push("Execution trace  (P pending, Q real-time queue, F feedback queue, R running,");
    out.push("                  S suspended, | terminated)");
    out.push("");
    function pad(s, w) { s = String(s); while (s.length < w) s += " "; return s; }
    var head = pad("T =", 5);
    for (var t = 0; t <= res.summary.lastTick; t++) head += pad(t, 6);
    out.push(head.replace(/\s+$/, ""));
    res.trace.forEach(function (row, i) {
      out.push((pad("P" + i + ":", 5) + row.map(function (c) { return pad(c, 6); }).join("")).replace(/\s+$/, ""));
    });
    out.push("");
    out.push("Average turnaround time: " + fixed2(res.summary.avgTurnaround) + " s, average waiting time: " +
             fixed2(res.summary.avgWaiting) + " s");
    return out.join("\n");
  }

  function jobFromArray(a) {
    var o = {};
    FIELDS.forEach(function (f, i) { o[f] = a[i]; });
    return o;
  }

  /* parse pasted text: one job per line "arrival, priority, cpu, mbytes, printers, scanners, modems, cds" */
  function parseJobs(text) {
    var jobs = [], errors = [];
    String(text).split(/\r?\n/).forEach(function (line, i) {
      var s = line.replace(/#.*$/, "").trim();
      if (!s) return;
      var parts = s.split(/[\s,]+/).filter(Boolean);
      var nums = parts.map(Number);
      if (parts.length !== 8 || nums.some(function (x) { return !isFinite(x); }))
        errors.push("Line " + (i + 1) + ": expected 8 numbers (arrival, priority, cpu, memory, printers, scanners, modems, cds).");
      else jobs.push(jobFromArray(nums));
    });
    return { jobs: jobs, errors: errors };
  }

  return {
    simulate: simulate, validate: validate, formatText: formatText, parseJobs: parseJobs, fixed2: fixed2,
    DEFAULT_CONFIG: DEFAULT_CONFIG, POLICY_NAMES: POLICY_NAMES,
    FIELDS: FIELDS, jobFromArray: jobFromArray, MAXJOBS: MAXJOBS, N_FEEDBACK: N_FEEDBACK,
    MAXTICKS: MAXTICKS, DISPLAY_TICKS: DISPLAY_TICKS, TRACE_TEXT_MAX: TRACE_TEXT_MAX,
  };
});
