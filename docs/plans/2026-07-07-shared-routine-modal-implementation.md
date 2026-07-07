# Shared Routine Modal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the duplicated capture-board routine form and OKR routine-link popover with one shared dialog modal.

**Architecture:** Keep routine persistence and OKR linking on the existing query hooks. Extract a dialog shell that can render `RoutineForm` for create/edit and a link-existing section for OKR mode. Do not add IPC, migrations, global modal state, or new design primitives.

**Tech Stack:** React, TypeScript, shadcn Dialog/Button/Input/Checkbox, TanStack Query hooks, Vitest happy-dom DOM tests.

---

### Task 1: Extend RoutineForm Defaults

**Files:**

- Modify: `src/components/board/RoutineForm.tsx`
- Test: `src/components/board/RoutinesPanel.dom.test.tsx`

**Step 1: Write the failing test**

Add a DOM test that opens the board create flow and asserts the form is inside a dialog while still submitting the same draft shape.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/board/RoutinesPanel.dom.test.tsx`

Expected: FAIL because the create form is still inline, not dialog-backed.

**Step 3: Implement minimal form default support**

Add an optional `defaults` prop to `RoutineForm` for title, startDate, and endDate. Existing `initial` values take precedence.

**Step 4: Run test to verify it passes after modal extraction**

Run: `pnpm vitest run src/components/board/RoutinesPanel.dom.test.tsx`

Expected: PASS.

### Task 2: Add Shared RoutineModal

**Files:**

- Create: `src/components/board/RoutineModal.tsx`
- Modify: `src/components/board/RoutinesPanel.tsx`
- Test: `src/components/board/RoutinesPanel.dom.test.tsx`

**Step 1: Write failing tests**

Add tests for board create/edit:

- `+ 루틴` opens a dialog with the routine title input.
- edit pencil opens the same dialog and seeds the selected routine.
- submit calls `onCreate` or `onUpdate` and closes the dialog.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/board/RoutinesPanel.dom.test.tsx`

Expected: FAIL because `RoutineModal` does not exist and `RoutinesPanel` still renders `RoutineForm` inline.

**Step 3: Implement minimal modal**

Create `RoutineModal` using shadcn `Dialog`, `DialogContent`, and `DialogTitle`. Move `RoutinesPanel` create/edit state to `{ mode: "create" | "edit"; routineId?: string } | null`, render `RoutineModal`, and keep the old submit callbacks unchanged.

**Step 4: Run tests**

Run: `pnpm vitest run src/components/board/RoutinesPanel.dom.test.tsx`

Expected: PASS.

### Task 3: Convert OKR RoutineLinkControl

**Files:**

- Modify: `src/components/okr/RoutineLinkControl.tsx`
- Test: `src/components/okr/RoutineLinkControl.dom.test.tsx`

**Step 1: Write failing OKR tests**

Create tests that mock query hooks and verify:

- button opens a dialog, not a popover.
- existing routine selection calls `setKeyResultRoutine`.
- unlink calls `setKeyResultRoutine` with `routineId: null`.
- create-and-link submits a routine input with `startDate=quarterStart`, `endDate=quarterEnd`, then links the returned id.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/okr/RoutineLinkControl.dom.test.tsx`

Expected: FAIL because current implementation uses a popover and its own mini create form.

**Step 3: Implement conversion**

Replace `Popover` with shared `RoutineModal`. Use `useRoutineTracking(localToday(), 1)` for selectable routines as today. Use `useCreateRoutine` and `useSetKeyResultRoutine` for create/link chaining.

**Step 4: Run tests**

Run: `pnpm vitest run src/components/okr/RoutineLinkControl.dom.test.tsx`

Expected: PASS.

### Task 4: Cleanup Styles and Copy Guard

**Files:**

- Modify: `src/components/MissionView.css`
- Modify: `src/components/MissionView.copy.test.ts`
- Modify: `src/components/CaptureBoard.css` only if modal-specific spacing cannot be expressed with utility classes

**Step 1: Write failing cleanup check**

Update copy/source tests so they no longer require the old popover-only text structure and still assert the automation framing text exists.

**Step 2: Run focused tests**

Run: `pnpm vitest run src/components/MissionView.copy.test.ts src/components/okr/RoutineLinkControl.dom.test.tsx src/components/board/RoutinesPanel.dom.test.tsx`

Expected: PASS after cleanup.

### Task 5: Full Frontend Verification

**Files:**

- No production edits unless verification exposes a defect.

**Step 1: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS.

**Step 2: Run lint**

Run: `pnpm lint`

Expected: PASS.

**Step 3: Run vitest**

Run: `pnpm vitest run`

Expected: PASS.

**Step 4: Report**

Summarize changed files, tests run, and any skipped Tauri/browser smoke. Do not claim unrun checks passed.
