import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const sourceFile = (file) => /\.(?:[cm]?js|jsx|tsx?|css|html|py)$/.test(file) && !/(?:^|\/)qa\//.test(file);
const category = (file) => {
  if (file.startsWith("test/") || file.includes(".test.")) return "tests";
  if (/^(src|server)\//.test(file)) return "application";
  if (file.startsWith("designs/")) return "prototype";
  return "tooling";
};

function measure(ref) {
  const names = ref
    ? git("ls-tree", "-r", "--name-only", "-z", ref)
    : git("ls-files", "--cached", "--others", "--exclude-standard", "-z");
  const files = [];
  for (const file of new Set(names.split("\0").filter(sourceFile))) {
    let text;
    try { text = ref ? git("show", `${ref}:${file}`) : readFileSync(file, "utf8"); }
    catch (error) { if (!ref && error.code === "ENOENT") continue; throw error; }
    const lines = text ? text.trimEnd().split("\n") : [];
    files.push({ file, category: category(file), lines: lines.length, nonblank: lines.filter((line) => line.trim()).length });
  }
  const totals = Object.fromEntries(["application", "tests", "prototype", "tooling", "total"].map((group) => {
    const subset = group === "total" ? files : files.filter((file) => file.category === group);
    return [group, { lines: subset.reduce((sum, file) => sum + file.lines, 0), nonblank: subset.reduce((sum, file) => sum + file.nonblank, 0), files: subset.length }];
  }));
  return { totals, largest: files.filter((file) => file.category === "application").sort((a, b) => b.lines - a.lines).slice(0, 10) };
}

const baseArg = process.argv.slice(2).find((arg) => arg !== "--json");
const base = baseArg ? git("rev-parse", "--verify", "--end-of-options", `${baseArg}^{commit}`).trim() : null;
const result = { base, before: base ? measure(base) : null, after: measure() };
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("Physical source lines, including comments; excludes lockfiles, assets, QA snapshots, and generated output.");
  for (const [group, after] of Object.entries(result.after.totals)) {
    const before = result.before?.totals[group];
    console.log(`${group.padEnd(12)} ${before ? `${before.lines} -> ` : ""}${after.lines}${before?.lines ? ` (${((after.lines / before.lines - 1) * 100).toFixed(1)}%)` : ""}`);
  }
}
