import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkFrontendOwnership } from "./check-frontend-ownership.mjs";

async function makeFixture(files) {
  const root = join(
    tmpdir(),
    `work-radar-ownership-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(root, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    if (contents === undefined) continue;
    const fullPath = join(root, path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, contents);
  }
  return root;
}

function validFiles(overrides = {}) {
  return {
    "src/styles.css": '@import "./styles/tokens.css";\n@import "./styles/base.css";\n',
    "src/styles/shared.css": ".sr-only { position: absolute; }\n",
    "src/components/worktree/WorktreeView.tsx": 'import { useProjects } from "@/lib/query";\n',
    "src/components/worktree/WorktreeHeader.tsx":
      "export function WorktreeHeader() { return null; }\n",
    "src/components/worktree/WorktreeBody.tsx": "export function WorktreeBody() { return null; }\n",
    "src/components/worktree/WorktreeSidebar.tsx":
      "export function WorktreeSidebar() { return null; }\n",
    "src/components/worktree/WorktreeLensToolbar.tsx":
      "export function WorktreeLensToolbar() { return null; }\n",
    "src/components/worktree/WorktreeRefsBar.tsx":
      "export function WorktreeRefsBar() { return null; }\n",
    "src/components/worktree/WorktreeDiffPanel.tsx":
      "export function WorktreeDiffPanel() { return null; }\n",
    "src/components/worktree/WorktreeEmptyState.tsx":
      "export function WorktreeEmptyState() { return null; }\n",
    "src/components/jobs/JobsView.tsx": 'import { useCodexStatus } from "@/lib/query";\n',
    "src/components/jobs/JobsHeader.tsx": "export function JobsHeader() { return null; }\n",
    "src/components/jobs/CodexStatusBanner.tsx":
      "export function CodexStatusBanner() { return null; }\n",
    "src/components/jobs/JobControls.tsx": "export function JobControls() { return null; }\n",
    "src/components/jobs/JobList.tsx": "export function JobList() { return null; }\n",
    "src/components/jobs/JobCard.tsx": "export function JobCard() { return null; }\n",
    "src/components/jobs/ProposalPanel.tsx": "export function ProposalPanel() { return null; }\n",
    "src/components/CaptureBoard.tsx": 'import { useSignals } from "@/lib/query";\n',
    "src/components/board/CaptureBoardHeader.tsx":
      "export function CaptureBoardHeader() { return null; }\n",
    "src/components/board/ExecutionRail.tsx": "export function ExecutionRail() { return null; }\n",
    "src/components/board/BoardOverlays.tsx": "export function BoardOverlays() { return null; }\n",
    "src/components/board/boardOverlayUtils.ts": "export function message() { return ''; }\n",
    "src/components/board/MatrixCanvas.tsx":
      'import { computeZonePositions } from "@/components/board/matrixGeometry";\n',
    "src/components/board/matrixGeometry.ts":
      "export function computeZonePositions() { return []; }\n",
    "src/components/board/matrixGeometry.test.ts": "import './matrixGeometry';\n",
    "src/components/TodayView.tsx":
      'import { useTimelineScroll } from "@/components/today/useTimelineScroll";\n',
    ...overrides,
  };
}

test("passes the current orchestrator/domain-section/leaf shape", async () => {
  const root = await makeFixture(validFiles());
  assert.deepEqual(await checkFrontendOwnership(root), []);
});

test("rejects atomic design folders", async () => {
  const root = await makeFixture(
    validFiles({
      "src/components/atoms/Button.tsx": "export function Button() { return null; }\n",
    }),
  );
  const failures = await checkFrontendOwnership(root);
  assert.match(failures.join("\n"), /Atomic design folder is forbidden/);
});

test("rejects query ownership moving into extracted leaves", async () => {
  const root = await makeFixture(
    validFiles({
      "src/components/jobs/JobCard.tsx":
        'import { useCodexStatus } from "@/lib/query";\nexport function JobCard() { return null; }\n',
    }),
  );
  const failures = await checkFrontendOwnership(root);
  assert.match(
    failures.join("\n"),
    /Query orchestration must stay in src\/components\/jobs\/JobsView\.tsx/,
  );
});

test("rejects shared css component namespaces", async () => {
  const root = await makeFixture(
    validFiles({
      "src/styles/shared.css": ".wt-panel { display: grid; }\n",
    }),
  );
  const failures = await checkFrontendOwnership(root);
  assert.match(failures.join("\n"), /Component namespace selectors are forbidden/);
});

test("rejects large orchestrators without a custom hook boundary", async () => {
  const root = await makeFixture(
    validFiles({
      "src/components/TodayView.tsx": Array.from({ length: 300 }, (_, i) =>
        i === 0 ? "export function TodayView() { return null; }" : `// filler ${i}`,
      ).join("\n"),
    }),
  );
  const failures = await checkFrontendOwnership(root);
  assert.match(
    failures.join("\n"),
    /large orchestrators must extract lifecycle\/state details behind a local custom hook boundary/,
  );
});
