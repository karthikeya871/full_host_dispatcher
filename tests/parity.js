/*
 * Parity test: the JavaScript engine must produce exactly the same events,
 * trace and averages as the C program, for the job lists in c-implementation/
 * and for random job lists, under all four memory policies, with and without aging.
 *
 *   cd c-implementation && make && cd ..
 *   node tests/parity.js [random-cases]        (default 300)
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const H = require("../dispatcher.js");

const cdir = path.join(__dirname, "..", "c-implementation");
const hostBin = path.join(cdir, "host");
if (!fs.existsSync(hostBin)) {
  console.error("Build the C program first: cd c-implementation && make");
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "host-parity-"));

function normalise(text) {
  return text
    .replace(/, pid \d+/g, "")
    .replace(/, tick \d+ ms/g, "")
    .split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").trim();
}

function jobsToFile(jobs, name) {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, jobs.map((j) => H.FIELDS.map((k) => j[k]).join(", ")).join("\n") + "\n");
  return f;
}

function runC(file, policy, userMem, aging) {
  return execFileSync(hostBin, ["-t", "0", "-p", policy, "-m", String(userMem), "-a", String(aging), file], {
    cwd: cdir, encoding: "utf8", timeout: 20000,
  });
}

function runJS(jobs, policy, userMem, aging) {
  const res = H.simulate(jobs, { policy, userMem, aging });
  if (!res.ok) throw new Error("JS rejected a valid list: " + JSON.stringify(res.errors));
  return H.formatText(res);
}

let cases = 0, fails = 0;
function check(label, jobs, policy, userMem, aging) {
  aging = aging || 0;
  const file = jobsToFile(jobs, "case.txt");
  let c, j;
  try { c = normalise(runC(file, policy, userMem, aging)); } catch (e) { c = "C failed: " + e.message; }
  try { j = normalise(runJS(jobs, policy, userMem, aging)); } catch (e) { j = "JS failed: " + e.message; }
  cases++;
  if (c !== j) {
    fails++;
    console.log("MISMATCH: " + label + " policy=" + policy + " mem=" + userMem + " aging=" + aging);
    console.log(jobs.map((x) => H.FIELDS.map((k) => x[k]).join(", ")).join("\n"));
    const cl = c.split("\n"), jl = j.split("\n");
    for (let i = 0; i < Math.max(cl.length, jl.length); i++)
      if (cl[i] !== jl[i]) { console.log("  C : " + cl[i] + "\n  JS: " + jl[i]); break; }
  }
}

// 1. the job lists in c-implementation/, every policy, with and without aging
for (const f of fs.readdirSync(cdir).filter((n) => /^jobs_.*\.txt$/.test(n))) {
  const jobs = H.parseJobs(fs.readFileSync(path.join(cdir, f), "utf8")).jobs;
  for (const policy of ["first", "next", "best", "worst"])
    for (const aging of [0, 2, 5])
      for (const mem of [960, 1024]) check(f, jobs, policy, mem, aging);
}

// 2. random lists (some with aging)
let seed = 12345;
function rnd(n) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; }
const sizes = [16, 32, 64, 128, 192, 256, 384, 512, 700, 900];
const N = parseInt(process.argv[2] || "300", 10);
for (let k = 0; k < N; k++) {
  const userMem = [300, 512, 960, 1024][rnd(4)];
  const n = 1 + rnd(12);
  const jobs = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    t += rnd(4);
    const rt = rnd(5) === 0;
    const sz = sizes.filter((s) => s <= (rt ? 64 : userMem));
    jobs.push({
      arrival: t, priority: rt ? 0 : 1 + rnd(3), cpu: 1 + rnd(5),
      mbytes: sz[rnd(sz.length)],
      printers: rt ? 0 : rnd(3), scanners: rt ? 0 : rnd(2), modems: rt ? 0 : rnd(2), cds: rt ? 0 : rnd(3),
    });
  }
  check("random " + k, jobs, ["first", "next", "best", "worst"][rnd(4)], userMem, [0, 0, 1, 2, 3, 5][rnd(6)]);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(cases + " cases compared, " + fails + " mismatches");
process.exit(fails ? 1 : 0);
