// Turns vitest's coverage/coverage-summary.json into a shields.io endpoint
// payload (https://shields.io/badges/endpoint-badge). CI pushes the payload to
// the `badges` branch on every merge to main, and the README's badge image
// points shields.io at that file — so the number updates without any external
// coverage service.
//
// Usage:
//   node scripts/coverage-badge.mjs            # writes coverage/badge.json
//   node scripts/coverage-badge.mjs --summary  # also prints a markdown table
//                                              # (CI appends it to the PR's
//                                              # job summary)
import { readFileSync, writeFileSync } from "node:fs";

const summary = JSON.parse(
    readFileSync("coverage/coverage-summary.json", "utf8"),
);
const total = summary.total;
const pct = total.statements.pct;

// The usual shields ramp: green is earned, red is a warning light.
function color(n) {
    if (n >= 90) return "brightgreen";
    if (n >= 80) return "green";
    if (n >= 70) return "yellowgreen";
    if (n >= 60) return "yellow";
    if (n >= 50) return "orange";
    return "red";
}

const badge = {
    schemaVersion: 1,
    label: "coverage",
    message: `${pct.toFixed(1)}%`,
    color: color(pct),
};

writeFileSync("coverage/badge.json", `${JSON.stringify(badge, null, 4)}\n`);
console.error(`coverage/badge.json: ${badge.message} (${badge.color})`);

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
