#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LINES = new Map([
  ["src/components/TodayView.tsx", 420],
  ["src/components/worktree/WorktreeView.tsx", 450],
  ["src/components/jobs/JobsView.tsx", 220],
  ["src/components/CaptureBoard.tsx", 650],
  ["src/components/board/MatrixCanvas.tsx", 580],
]);

const REQUIRED_FILES = [
  "src/components/worktree/WorktreeHeader.tsx",
  "src/components/worktree/WorktreeBody.tsx",
  "src/components/worktree/WorktreeLensToolbar.tsx",
  "src/components/worktree/WorktreeRefsBar.tsx",
  "src/components/worktree/WorktreeDiffPanel.tsx",
  "src/components/worktree/WorktreeEmptyState.tsx",
  "src/components/jobs/JobsHeader.tsx",
  "src/components/jobs/CodexStatusBanner.tsx",
  "src/components/jobs/JobControls.tsx",
  "src/components/jobs/JobList.tsx",
  "src/components/jobs/JobCard.tsx",
  "src/components/jobs/ProposalPanel.tsx",
  "src/components/board/CaptureBoardHeader.tsx",
  "src/components/board/ExecutionRail.tsx",
  "src/components/board/BoardOverlays.tsx",
  "src/components/board/boardOverlayUtils.ts",
  "src/components/board/matrixGeometry.ts",
  "src/components/board/matrixGeometry.test.ts",
];

const QUERY_IMPORT_RE =
  /from\s+["']@\/lib\/query(?:\/[^"']*)?["']|from\s+["']\.\.\/(?:\.\.\/)*lib\/query(?:\/[^"']*)?["']/;
const COMPONENT_NAMESPACE_RE = /\.(?:cb|wt|jobs|asb|today)(?:[-_a-zA-Z0-9]|\b)/;
const CUSTOM_HOOK_BOUNDARY_MIN_LINES = 300;
const CUSTOM_HOOK_BOUNDARY_RE =
  /from\s+["'](?:@\/(?:components|lib)\/[^"']*\/use[A-Z][^"']*|\.{1,2}\/[^"']*\/use[A-Z][^"']*)["']|function\s+use[A-Z]\w*\s*\(/;

const LEAF_OWNERSHIP = [
  {
    label: "Worktree",
    container: "src/components/worktree/WorktreeView.tsx",
    files: [
      "src/components/worktree/WorktreeHeader.tsx",
      "src/components/worktree/WorktreeBody.tsx",
      "src/components/worktree/WorktreeLensToolbar.tsx",
      "src/components/worktree/WorktreeRefsBar.tsx",
      "src/components/worktree/WorktreeDiffPanel.tsx",
      "src/components/worktree/WorktreeEmptyState.tsx",
    ],
  },
  {
    label: "Jobs",
    container: "src/components/jobs/JobsView.tsx",
    files: [
      "src/components/jobs/JobsHeader.tsx",
      "src/components/jobs/CodexStatusBanner.tsx",
      "src/components/jobs/JobControls.tsx",
      "src/components/jobs/JobList.tsx",
      "src/components/jobs/JobCard.tsx",
      "src/components/jobs/ProposalPanel.tsx",
    ],
  },
  {
    label: "CaptureBoard",
    container: "src/components/CaptureBoard.tsx",
    files: [
      "src/components/board/CaptureBoardHeader.tsx",
      "src/components/board/ExecutionRail.tsx",
      "src/components/board/BoardOverlays.tsx",
    ],
  },
];

function rel(root, path) {
  return relative(root, path).split(sep).join("/");
}

async function readText(root, path) {
  return readFile(resolve(root, path), "utf8");
}

async function listDirs(root, start) {
  const out = [];
  const fullStart = resolve(root, start);
  if (!existsSync(fullStart)) return out;
  async function walk(dir) {
    for (const entry of await readdir(dir)) {
      const fullPath = resolve(dir, entry);
      const info = await stat(fullPath);
      if (info.isDirectory()) {
        out.push(rel(root, fullPath));
        await walk(fullPath);
      }
    }
  }
  await walk(fullStart);
  return out;
}

function countLines(text) {
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

function isImportOnlyCss(text) {
  return stripCssComments(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .every((line) => line.startsWith("@import "));
}

export async function checkFrontendOwnership(root = process.cwd()) {
  const failures = [];

  for (const dir of await listDirs(root, "src/components")) {
    const leaf = dir.split("/").at(-1);
    if (["atoms", "molecules", "organisms"].includes(leaf)) {
      failures.push(`${dir}: Atomic design folder is forbidden; use workflow/domain names.`);
    }
  }

  for (const file of REQUIRED_FILES) {
    if (!existsSync(resolve(root, file))) {
      failures.push(`${file}: required frontend ownership boundary file is missing.`);
    }
  }

  for (const [file, max] of MAX_LINES) {
    if (!existsSync(resolve(root, file))) continue;
    const text = await readText(root, file);
    const lines = countLines(text);
    if (lines > max) {
      failures.push(`${file}: ${lines} lines exceeds ownership guard limit ${max}.`);
    }
    if (lines >= CUSTOM_HOOK_BOUNDARY_MIN_LINES && !CUSTOM_HOOK_BOUNDARY_RE.test(text)) {
      failures.push(
        `${file}: large orchestrators must extract lifecycle/state details behind a local custom hook boundary.`,
      );
    }
  }

  if (existsSync(resolve(root, "src/styles.css"))) {
    const styles = await readText(root, "src/styles.css");
    if (!isImportOnlyCss(styles)) {
      failures.push("src/styles.css: must remain an @import-only hub.");
    }
  }

  if (existsSync(resolve(root, "src/styles/shared.css"))) {
    const shared = stripCssComments(await readText(root, "src/styles/shared.css"));
    if (COMPONENT_NAMESPACE_RE.test(shared)) {
      failures.push(
        "src/styles/shared.css: Component namespace selectors are forbidden; colocate component CSS.",
      );
    }
  }

  for (const group of LEAF_OWNERSHIP) {
    for (const file of group.files) {
      if (!existsSync(resolve(root, file))) continue;
      const text = await readText(root, file);
      if (QUERY_IMPORT_RE.test(text)) {
        failures.push(
          `${file}: Query orchestration must stay in ${group.container}, not ${group.label} leaves.`,
        );
      }
    }
  }

  if (existsSync(resolve(root, "src/components/board/MatrixCanvas.tsx"))) {
    const matrix = await readText(root, "src/components/board/MatrixCanvas.tsx");
    if (!matrix.includes("matrixGeometry")) {
      failures.push(
        "src/components/board/MatrixCanvas.tsx: pure geometry must stay in matrixGeometry.ts.",
      );
    }
  }

  return failures;
}

async function main() {
  const root = resolve(process.argv[2] ?? process.cwd());
  const failures = await checkFrontendOwnership(root);
  if (failures.length > 0) {
    console.error("frontend ownership guard failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log("frontend ownership guard passed");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
