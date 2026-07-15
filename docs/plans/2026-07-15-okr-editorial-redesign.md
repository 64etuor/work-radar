# OKR Editorial Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Mission / OKR 페이지를 기존 기능을 보존한 editorial workflow로 재구성한다.

**Architecture:** 기존 `MissionView` query orchestration과 OKR 하위 컴포넌트 경계를 유지한다.
표시용 구조와 Mission 전용 CSS만 조정하고, 기존 shadcn 프리미티브와 `typo-*`/`--wr-*`
토큰을 재사용한다.

**Tech Stack:** React 19, TypeScript, Tailwind v4 tokens, component CSS, shadcn/ui, Vitest, Tauri 2

---

### Task 1: Lock the editorial layout contract

**Files:**

- Modify: `src/components/MissionView.layout.test.ts`
- Modify: `src/components/MissionView.copy.test.ts`

**Step 1:** Add assertions for the editorial header metrics, sticky season navigation, numbered
Objective section, Korean tab labels, composed loading/error/empty states, and responsive layout.

**Step 2:** Run `pnpm vitest run src/components/MissionView.layout.test.ts src/components/MissionView.copy.test.ts`.
Expected: FAIL because the new structure and selectors do not exist yet.

### Task 2: Build the editorial page hierarchy

**Files:**

- Modify: `src/components/MissionView.tsx`
- Modify: `src/components/okr/ObjectiveCard.tsx`
- Modify: `src/components/okr/WeeklyCheckInPanel.tsx`
- Modify: `src/components/okr/HorizonShelf.tsx`

**Step 1:** Add the header metric group, sticky navigation status copy, loading/error/empty state
markup, Korean tab labels, and Objective position prop.

**Step 2:** Keep every existing query, mutation, focus target, and overlay prop unchanged.

### Task 3: Apply the Cohere editorial styling

**Files:**

- Modify: `src/components/MissionView.css`

**Step 1:** Convert the header and Objective shells to open, rule-separated layout using existing
tokens only.

**Step 2:** Add tablet/mobile layout rules and opacity-only loading motion.

**Step 3:** Re-run the targeted tests. Expected: PASS.

### Task 4: Verify behavior and visual quality

**Files:**

- Test: `src/components/MissionView.layout.test.ts`
- Test: `src/components/MissionView.copy.test.ts`
- Test: `src/components/okr/FoundationPanels.dom.test.tsx`

**Step 1:** Run the full frontend verification commands from `docs/reference/commands.md`.

**Step 2:** Run `npx react-doctor@latest --verbose --scope changed --base HEAD` and resolve
changed-scope regressions.

**Step 3:** Boot `pnpm tauri dev` and capture fresh evidence at the default 750px window and a
desktop-width window. Verify the configured 560px minimum-width behavior through the responsive
layout contract and its tests. Exercise
tabs, inline mission editing, Objective dialog, and empty/loading/error surfaces where reachable.

**Step 4:** Run the visual QA dual review on the fresh captures and fix every blocking finding.
