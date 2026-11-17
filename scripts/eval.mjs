#!/usr/bin/env node
// One-command eval pipeline. Cross-platform: finds python3 / python / py -3.
//
//   node scripts/eval.mjs          CI mode: run the current prompt (v2), grade it, gate it,
//                                  and compare it with the committed baseline report.
//   node scripts/eval.mjs --all    Demo mode: run v1 and v2, rewrite the committed reports,
//                                  the before/after comparison and the README results table.
import { spawnSync } from "node:child_process";
import process from "node:process";

const all = process.argv.includes("--all");

function findPython() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push([process.env.PYTHON, []]);
  candidates.push(["python3", []], ["python", []], ["py", ["-3"]]);
  for (const [cmd, pre] of candidates) {
    const r = spawnSync(cmd, [...pre, "--version"], { encoding: "utf8" });
    if (r.status === 0 && /Python 3/.test(r.stdout + r.stderr)) return [cmd, pre];
  }
  throw new Error("Python 3 not found (tried $PYTHON, python3, python, py -3)");
}

function run(cmd, args, { allowFail = false } = {}) {
  console.log(`\n$ ${[cmd, ...args].join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) process.exit(r.status ?? 1);
  return r.status;
}

const [py, pre] = findPython();
const python = (...args) => run(py, [...pre, ...args]);
// Same command on every OS: this Node binary, with tsx registered as a loader.
const runAgent = (v) => run(process.execPath, ["--import", "tsx", "src/run-eval.ts", "--prompt", v]);

if (all) {
  for (const v of ["v1", "v2"]) {
    runAgent(v);
    python("evals/harness/report.py", "--run", `evals/runs/${v}`, "--out", `evals/reports/${v}`);
  }
  python("evals/harness/compare.py", "--base", "evals/reports/v1.json", "--head", "evals/reports/v2.json", "--out", "evals/reports/comparison.md");
  python("evals/harness/readme_table.py", "--write");
  // Show that the gate rejects v1 and accepts v2.
  const v1 = run(py, [...pre, "evals/harness/gate.py", "--report", "evals/reports/v1.json"], { allowFail: true });
  console.log(`(gate exit code for v1: ${v1}; non-zero is expected, v1 hallucinates)`);
  python("evals/harness/gate.py", "--report", "evals/reports/v2.json");
} else {
  runAgent("v2");
  python("evals/harness/report.py", "--run", "evals/runs/v2", "--out", "evals/runs/v2/report");
  python("evals/harness/gate.py", "--report", "evals/runs/v2/report.json");
  python("evals/harness/compare.py", "--base", "evals/reports/v2.json", "--head", "evals/runs/v2/report.json", "--fail-on-regression");
}
