# Shared Routine Modal Design

## Goal

Unify the capture-board routine settings flow and the OKR key-result routine-linking flow behind one modal so routine creation/editing uses one form contract and both surfaces stay synchronized through the same query invalidation path.

## Context

The current capture board owns routine create/edit inline in `RoutinesPanel` with `RoutineForm`. OKR owns a separate `RoutineLinkControl` popover that can list routines, create a reduced routine shape, and link it to a key result. The backend already exposes the needed local commands: routine create/update/list/tracking and `set_key_result_routine`. No schema or IPC command change is needed.

## Chosen Approach

Create a shared `RoutineModal` under `src/components/board/` and reuse the existing `RoutineForm` as its form body. The modal supports:

- board create
- board edit
- OKR link existing routine
- OKR create routine and link it
- OKR unlink routine

The board remains the orchestration owner for routine list mutations. OKR keeps its key-result mutation owner, but uses the shared modal UI and existing routine create hook. `createRoutine` invalidates routine queries; OKR linking additionally invalidates OKR queries via `setKeyResultRoutine`.

## UI Contract

Use shadcn `Dialog` rather than a bespoke panel or popover. This keeps the existing `data-wr-overlay-open` Esc contract and focus behavior. Board triggers are `+ 루틴` and the row edit pencil. OKR keeps its row button, but it opens the modal instead of a popover.

`RoutineForm` gains optional defaults for fields that do not come from a `RoutineToday` record, especially OKR defaults:

- title defaults to the KR title
- start date defaults to quarter start
- end date defaults to quarter end

## Synchronization

Routine mutations continue through `src/lib/query/routines.ts` and `useInvalidate().routines()`. OKR link/unlink continues through `useSetKeyResultRoutine()`, which invalidates `okr`. The OKR create-and-link action chains `createRoutine.mutateAsync(input)` then `setRoutine.mutateAsync({ id: kr.id, routineId: routine.id })`.

## Tests

Add failing DOM tests before implementation:

- `RoutinesPanel` opens a dialog-backed routine form for create/edit and still submits the same draft payloads.
- `RoutineLinkControl` opens the shared modal, can unlink an existing routine, can create a routine with quarter-bound defaults, and links the returned routine id to the KR.

Verification after implementation:

- targeted Vitest DOM tests
- `pnpm typecheck`
- `pnpm lint`
- `pnpm vitest run`
