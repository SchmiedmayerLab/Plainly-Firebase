//
// This source file is part of the Plainly Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
//
// SPDX-License-Identifier: MIT
//

import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";

const minimumCoverage = 90;
const base = process.argv[2];

if (!base) {
  throw new Error("A base commit is required to calculate diff coverage");
}

const coverage = parseCoverage(
  readFileSync(resolve("coverage/lcov.info"), "utf8"),
);
const diff = execFileSync(
  "git",
  ["-C", "..", "diff", "--unified=0", "--diff-filter=ACMR", base, "--", "functions/src"],
  {encoding: "utf8"},
);
const changedLines = parseChangedLines(diff);
const coverableLines = [];

for (const [file, lines] of changedLines) {
  const fileCoverage = coverage.get(file);
  if (!fileCoverage) continue;

  for (const line of lines) {
    const hits = fileCoverage.get(line);
    if (hits !== undefined) {
      coverableLines.push({file, line, hits});
    }
  }
}

if (coverableLines.length === 0) {
  console.log("Diff coverage: no changed executable lines");
  process.exit(0);
}

const coveredLines = coverableLines.filter(({hits}) => hits > 0);
const percentage = coveredLines.length / coverableLines.length * 100;
const uncovered = coverableLines.filter(({hits}) => hits === 0);

console.log(
  `Diff coverage: ${percentage.toFixed(2)}% ` +
  `(${coveredLines.length}/${coverableLines.length} changed executable lines)`,
);

if (percentage < minimumCoverage) {
  console.error(`Required diff coverage: ${minimumCoverage}%`);
  for (const {file, line} of uncovered) {
    console.error(`  ${file}:${line}`);
  }
  process.exit(1);
}

function parseCoverage(lcov) {
  const files = new Map();
  let lines;

  for (const entry of lcov.split("\n")) {
    if (entry.startsWith("SF:")) {
      const file = entry.slice(3).replace(/^functions\//, "");
      lines = new Map();
      files.set(file, lines);
    } else if (entry.startsWith("DA:") && lines) {
      const [line, hits] = entry.slice(3).split(",").map(Number);
      lines.set(line, hits);
    }
  }

  return files;
}

function parseChangedLines(diff) {
  const files = new Map();
  let currentFile;

  for (const entry of diff.split("\n")) {
    if (entry.startsWith("+++ b/functions/")) {
      currentFile = entry.slice("+++ b/functions/".length);
      files.set(currentFile, new Set());
      continue;
    }

    if (!currentFile || !entry.startsWith("@@")) continue;
    const match = entry.match(/\+(\d+)(?:,(\d+))?/);
    if (!match) continue;

    const firstLine = Number(match[1]);
    const lineCount = Number(match[2] ?? 1);
    for (let line = firstLine; line < firstLine + lineCount; line += 1) {
      files.get(currentFile).add(line);
    }
  }

  return files;
}
