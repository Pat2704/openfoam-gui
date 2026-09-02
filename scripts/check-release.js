#!/usr/bin/env node
/**
 * check-release.js
 *
 * Refuses to let a release go out with names that disagree.
 *
 * The version in package.json is the single source of truth: the tag, the two
 * artifact filenames and the release-notes file all quote it. They drifted once
 * — v2.1.0 shipped with files called OpenFOAMStudio-v2-…, identical to the ones
 * already attached to v2.0.0 — and that is what this exists to prevent.
 *
 * Usage:
 *   node scripts/check-release.js            # tag = the one pointing at HEAD
 *   node scripts/check-release.js v2.2.0     # or state it explicitly
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const problems = [];

const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

// ── every place the version is written ──
const version = read("electron/package.json").version;
const rootVersion = read("package.json").version;
const lock = read("package-lock.json");

if (rootVersion !== version) {
  problems.push(`package.json is ${rootVersion}, electron/package.json is ${version}`);
}
if (lock.version !== version || lock.packages[""].version !== version) {
  problems.push(
    `package-lock.json is ${lock.version} / ${lock.packages[""].version}, expected ${version} ` +
      `(top-level fields only — the same string further down belongs to dependencies)`
  );
}

// ── the tag ──
let tag = process.argv[2];
if (!tag) {
  try {
    tag = execFileSync("git", ["tag", "--points-at", "HEAD"], { cwd: ROOT })
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .pop();
  } catch {
    /* no git, or no tag */
  }
}
if (!tag) {
  problems.push("no tag on HEAD, and none given on the command line");
} else if (tag !== `v${version}`) {
  problems.push(`tag is ${tag}, but package.json says ${version} — expected v${version}`);
}

// ── the artifacts, named after the same version ──
for (const suffix of ["portable.exe", "folder.zip"]) {
  const name = `OpenFOAMStudio-v${version}-${suffix}`;
  if (!fs.existsSync(path.join(ROOT, "dist-electron", name))) {
    problems.push(`dist-electron/${name} is missing — build before releasing`);
  }
}

// ── the notes ──
const notes = `docs/releases/v${version}.md`;
if (!fs.existsSync(path.join(ROOT, notes))) {
  problems.push(`${notes} is missing — write the release notes before releasing`);
}

if (problems.length) {
  console.error("[release] NOT ready:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`[release] ready: v${version}, both artifacts present, ${notes} written`);
