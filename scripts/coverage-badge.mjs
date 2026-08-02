// Rewrites the coverage badge in README.md from vitest's coverage summary.
//
// The badge is a plain shields.io static image with the number baked into the
// URL, so the README is self-describing: whatever the file says is what it
// renders, with no branch, gist or third-party service holding the real value.
// CI regenerates it on every pull request and commits the change to the PR
// branch, so the number arrives for review alongside the code that moved it.
//
// Usage (reports without touching the README unless asked):
//   node scripts/coverage-badge.mjs --write    # rewrite the README badge
//   node scripts/coverage-badge.mjs --check    # exit 1 if it is out of date
//   node scripts/coverage-badge.mjs --summary  # print a markdown table
//                                              # (CI appends it to the job
//                                              # summary on the checks tab)
import { readFileSync, writeFileSync } from "node:fs";

const SUMMARY_PATH = "coverage/coverage-summary.json";
const README_PATH = "README.md";

// Matches the badge's shields URL so only the number and colour are rewritten;
// the surrounding markdown (alt text, link target) is left to the README.
const BADGE_RE =
    /(!\[Test coverage\]\(https:\/\/img\.shields\.io\/badge\/coverage-)[^)]*(\))/;

// The usual shields ramp: green is earned, red is a warning light.
function color(n) {
    if (n >= 90) return "brightgreen";
    if (n >= 80) return "green";
    if (n >= 70) return "yellowgreen";
    if (n >= 60) return "yellow";
    if (n >= 50) return "orange";
    return "red";
}

const check = process.argv.includes("--check");
const write = process.argv.includes("--write");
const total = JSON.parse(readFileSync(SUMMARY_PATH, "utf8")).total;
const pct = total.statements.pct;

// `%` has to survive as `%25` inside the URL, and shields reads `-` as a field
// separator, hence the doubling in `73.0%25`-style messages.
const label = `${pct.toFixed(1)}%25-${color(pct)}`;
const readme = readFileSync(README_PATH, "utf8");

if (!BADGE_RE.test(readme)) {
    console.error(
        `${README_PATH}: no coverage badge found — expected a shields.io badge matching ${BADGE_RE}`,
    );
    process.exit(1);
}

const updated = readme.replace(BADGE_RE, `$1${label}$2`);
const stale = updated !== readme;

if (write && stale) writeFileSync(README_PATH, updated);

const state = stale
    ? write
        ? "updated to"
        : "is out of date, should be"
    : "is current at";
console.error(`${README_PATH}: coverage badge ${state} ${pct.toFixed(1)}%`);

// `--check` is the gate: non-zero when the README disagrees with the numbers.
if (check && stale) process.exit(1);

if (process.argv.includes("--summary")) {
    const row = (name, m) =>
        `| ${name} | ${m.pct.toFixed(2)}% | ${m.covered}/${m.total} |`;
    console.log(
        [
            "## Test coverage",
            "",
            "| | Coverage | Covered |",
            "| --- | --- | --- |",
            row("Statements", total.statements),
            row("Branches", total.branches),
            row("Functions", total.functions),
            row("Lines", total.lines),
        ].join("\n"),
    );
}
