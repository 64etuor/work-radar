# Timeline SSOT — Phase 2 (Rust-Boundary Calendar Time Normalization) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Normalize every TIMED Google calendar event's `start`/`end` to the viewer's local-offset ISO at the single Rust chokepoint, so the frontend's string-slice positioning and its `new Date()` label read the same wall-clock. This FIXES "calendar ↔ schedule misalignment" for events whose Google offset differs from local (UTC `Z`, foreign-TZ, DST).

**Architecture:** Phase 2 of the SSOT redesign (`docs/superpowers/specs/2026-06-20-today-timeline-coordinate-time-ssot-design.md` §3.2 / §4(2)). Normalization happens in `src-tauri/src/calendar/mod.rs::fetch_events_core` (the one place every emitted `CalendarEvent` is built). In-place change to `start`/`end` (struct shape unchanged). **Deviation from spec's "TS-first then Rust" sequencing:** a full consumer audit proved in-place Rust normalization is safe for all 9 consumers (each parses to epoch, slices the wall-clock prefix, or builds its own draft times), so we go straight to the durable Rust chokepoint — zero frontend churn, zero `bindings.ts` drift.

**Tech Stack:** Rust, chrono 0.4 (`clock` feature), tauri-specta. Frontend: untouched.

## Global Constraints

- **In-place, struct shape unchanged** → `src/bindings.ts` drift MUST be 0 (verify). `CalendarEvent` fields are not added/removed.
- **All-day events untouched.** `all_day == true` means `start`/`end` are `YYYY-MM-DD` (no time/offset) — pass through verbatim. Only timed events are normalized.
- **Output format exactly `YYYY-MM-DDTHH:MM:SS±HH:MM`** (no fractional seconds, no `Z`) so the frontend's fixed-position slices (`iso.slice(11,13)`/`(14,16)`) and `new Date()` both stay correct. Use `to_rfc3339_opts(chrono::SecondsFormat::Secs, false)`.
- **Defensive passthrough:** if a timed string fails `parse_from_rfc3339`, leave it unchanged (never panic, never drop the event). `#![deny(clippy::unwrap_used)]` is in force — no `.unwrap()`.
- **Local zone = `chrono::Local`** (per-instant, DST-correct) — NOT a single captured offset string. This matches the frontend's per-date local offset and the same-machine viewer zone.
- **Verification** (`docs/reference/commands.md`): `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`, `bindings.ts` drift check (`cargo test` regenerates; must be 0), `pnpm typecheck`.
- **Commit style:** Conventional Commits; body ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do NOT push. Stage only the files each task lists — NEVER `src-tauri/src/lib.rs` (unrelated WIP), never `-A`/`.`.
- **cargo PATH:** `export PATH="$HOME/.cargo/bin:$PATH"` before cargo commands (`docs/areas/shell-tooling.md`).

---

## File Structure

- **Modify** `src-tauri/src/calendar/mod.rs` — add a private `normalize_timed_to_local(s: &str) -> String` helper; call it for timed events when building `CalendarEvent` in `fetch_events_core` (~lines 197–212).
- **Modify** `src-tauri/src/calendar/tests.rs` — add tests: a `Z`/UTC event and a foreign-offset event both normalize to local wall-clock; an all-day event passes through unchanged; an unparseable timed string passes through unchanged.

(No frontend files. No `models/calendar.rs` change. No `parse.rs` change — raw stays raw until the chokepoint.)

---

### Task 1: `normalize_timed_to_local` helper + unit tests (TDD)

**Files:**

- Modify: `src-tauri/src/calendar/mod.rs` (add private fn + a `#[cfg(test)]` unit module, OR put tests in `calendar/tests.rs` — match where existing unit tests for mod.rs live; prefer `calendar/tests.rs` if that is the convention).
- Test: `src-tauri/src/calendar/tests.rs`

**Interfaces:**

- Produces: `fn normalize_timed_to_local(s: &str) -> String` — timed RFC3339 (any offset / `Z`) → `YYYY-MM-DDTHH:MM:SS±HH:MM` in `chrono::Local`; unparseable input returned unchanged. (All-day handling is the CALLER's responsibility via the `all_day` flag — this helper is only ever called for timed strings.)

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/calendar/tests.rs` (adapt imports to the module path, e.g. `use crate::calendar::normalize_timed_to_local;`). These assert the LOCAL wall-clock; since CI/dev machines vary, assert by re-parsing to an instant AND by checking the offset matches `chrono::Local` for that instant rather than hard-coding `+09:00`:

```rust
#[test]
fn normalize_timed_utc_to_local_preserves_instant_and_uses_local_offset() {
    // 2026-06-20T05:30:00Z is one instant; normalized must be the SAME instant,
    // rendered with the machine's local offset and no fractional seconds / no 'Z'.
    let out = normalize_timed_to_local("2026-06-20T05:30:00Z");
    let got = chrono::DateTime::parse_from_rfc3339(&out).expect("normalized is valid rfc3339");
    let src = chrono::DateTime::parse_from_rfc3339("2026-06-20T05:30:00Z").unwrap();
    assert_eq!(got.timestamp(), src.timestamp(), "instant preserved");
    // offset equals chrono::Local's offset for that instant
    let expected_offset = src.with_timezone(&chrono::Local).offset().fix();
    assert_eq!(got.offset(), &expected_offset, "rendered in local offset");
    assert!(!out.contains('Z') && !out.contains('.'), "no Z, no fractional: {out}");
    // fixed char positions the frontend slices rely on
    assert_eq!(&out[10..11], "T");
    assert_eq!(out.len(), 25, "YYYY-MM-DDTHH:MM:SS+HH:MM is 25 chars: {out}");
}

#[test]
fn normalize_timed_foreign_offset_to_local_preserves_instant() {
    let out = normalize_timed_to_local("2026-06-20T14:30:00-07:00");
    let got = chrono::DateTime::parse_from_rfc3339(&out).unwrap();
    let src = chrono::DateTime::parse_from_rfc3339("2026-06-20T14:30:00-07:00").unwrap();
    assert_eq!(got.timestamp(), src.timestamp());
    assert_eq!(got.offset(), src.with_timezone(&chrono::Local).offset().fix());
}

#[test]
fn normalize_timed_unparseable_passes_through() {
    assert_eq!(normalize_timed_to_local("not-a-date"), "not-a-date");
    assert_eq!(normalize_timed_to_local(""), "");
}
```

(If `.offset().fix()` needs an import, add `use chrono::Offset;`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test calendar:: 2>&1 | tail -30`
Expected: FAIL — `cannot find function normalize_timed_to_local`.

- [ ] **Step 3: Write the helper**

In `src-tauri/src/calendar/mod.rs`, add (near the other private helpers; keep it `pub(crate)` if the test imports it via `crate::calendar::`):

```rust
/// 타임드 RFC3339(어떤 오프셋/`Z`든)을 뷰어 로컬 존(`chrono::Local`, per-instant DST 정확)으로
/// 정규화해 `YYYY-MM-DDTHH:MM:SS±HH:MM`(소수초 없음·`Z` 없음)로 반환한다. 프런트의 고정 위치
/// 슬라이스(`iso.slice(11,16)`)와 `new Date()`가 동일 wall-clock을 읽도록 만든다(스펙 §3.2).
/// 파싱 불가 입력은 그대로 반환(이벤트 유실/패닉 금지). 종일 이벤트는 호출부가 `all_day`로 분기.
pub(crate) fn normalize_timed_to_local(s: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(s) {
        Ok(dt) => dt
            .with_timezone(&chrono::Local)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
        Err(_) => s.to_string(),
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test calendar:: 2>&1 | tail -30`
Expected: PASS (3 new tests).

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src-tauri/src/calendar/mod.rs src-tauri/src/calendar/tests.rs
git commit -m "feat(calendar): normalize_timed_to_local helper (Google offset -> viewer local ISO)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Apply normalization in `fetch_events_core` + integration tests

**Files:**

- Modify: `src-tauri/src/calendar/mod.rs` — `fetch_events_core`, the `CalendarEvent { start: r.start, end: r.end, ... }` construction (~lines 197–212).
- Test: `src-tauri/src/calendar/tests.rs` — extend the existing `fetch_events_core_*` test (it uses a mock `CalendarProvider`).

**Interfaces:**

- Consumes: `normalize_timed_to_local` from Task 1.
- Produces: every `CalendarEvent` emitted by `fetch_events_core` has timed `start`/`end` in local offset; all-day unchanged. Struct shape unchanged.

- [ ] **Step 1: Write the failing integration test**

Extend `src-tauri/src/calendar/tests.rs`. Using the existing mock provider pattern, return a RawEvent with a UTC `start`/`end` and an all-day RawEvent, then assert the fetched `CalendarEvent`s:

```rust
#[tokio::test]
async fn fetch_events_core_normalizes_timed_to_local_keeps_all_day() {
    // Build a mock provider returning: one timed UTC event + one all-day event.
    // (Mirror the existing fetch_events_core_* test's provider/projects setup.)
    let provider = /* mock returning vec![
        RawEvent timed: start "2026-06-20T05:30:00Z", end "2026-06-20T06:30:00Z", all_day false,
        RawEvent all-day: start "2026-06-20", end "2026-06-21", all_day true,
    ] */;
    let events = fetch_events_core(&provider, projects, "tmin", "tmax").await;

    let timed = events.iter().find(|e| !e.all_day).expect("timed event present");
    // same instant, local offset, no Z
    let got = chrono::DateTime::parse_from_rfc3339(&timed.start).unwrap();
    let src = chrono::DateTime::parse_from_rfc3339("2026-06-20T05:30:00Z").unwrap();
    assert_eq!(got.timestamp(), src.timestamp());
    assert!(!timed.start.contains('Z'));

    let all_day = events.iter().find(|e| e.all_day).expect("all-day event present");
    assert_eq!(all_day.start, "2026-06-20", "all-day passes through unchanged");
    assert_eq!(all_day.end, "2026-06-21");
}
```

(Match the EXACT mock/provider/projects construction the existing `fetch_events_core_merges_sorts_isolates` test uses — read it first and reuse its helpers.)

- [ ] **Step 2: Run to verify it fails**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test calendar::fetch_events_core 2>&1 | tail -30`
Expected: FAIL — timed `start` still contains `Z` (not yet normalized).

- [ ] **Step 3: Apply normalization at the chokepoint**

In `fetch_events_core`, replace the `start`/`end` assignment in the `CalendarEvent { ... }` construction. Current:

```rust
                    start: r.start,
                    end: r.end,
```

New (normalize only timed; all-day verbatim):

```rust
                    start: if r.all_day { r.start } else { normalize_timed_to_local(&r.start) },
                    end: if r.all_day { r.end } else { normalize_timed_to_local(&r.end) },
```

(`r.all_day` is consumed by `all_day: r.all_day` later in the same struct literal; reading `r.all_day` (a `bool`, `Copy`) before the move of `r.start`/`r.end` is fine. If the borrow checker complains about partial moves, bind `let all_day = r.all_day;` above the struct literal and use it in both places.)

- [ ] **Step 4: Run to verify it passes + full calendar suite**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test calendar:: 2>&1 | tail -30`
Expected: PASS (new integration test + all existing calendar tests green — sort/merge/urgency are epoch-based so unaffected).

- [ ] **Step 5: Full gate + bindings drift**

Run:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo fmt --check && cd ..
pnpm typecheck
```

Then confirm `bindings.ts` drift is 0 (struct shape unchanged): `git status --short src/bindings.ts` should show NO modification. If `bindings.ts` changed, STOP — the struct shape was accidentally altered; investigate.

- [ ] **Step 6: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src-tauri/src/calendar/mod.rs src-tauri/src/calendar/tests.rs
git commit -m "fix(today): normalize Google event times to viewer-local ISO at fetch boundary

Fixes calendar<->schedule vertical misalignment for events whose Google offset
differs from local (UTC/foreign-TZ/DST): the timeline positions blocks by
string-slicing wall-clock digits, so events must arrive already in local offset.
In-place, struct unchanged (bindings drift 0); all-day events untouched; all
consumers verified safe (epoch-parse / wall-clock-slice / own-draft-times).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 2 Done-Criteria (evidence, not prose)

- [ ] Timed Google events (`Z` / foreign offset) emit as `YYYY-MM-DDTHH:MM:SS±HH:MM` in `chrono::Local`, same instant. All-day events unchanged.
- [ ] `cargo test` green (new helper + integration tests + all existing calendar tests); `cargo clippy -D warnings` clean; `cargo fmt --check` clean.
- [ ] `bindings.ts` drift 0; `pnpm typecheck` 0 (frontend untouched).
- [ ] Live native WKWebView smoke: a calendar event whose offset ≠ local (e.g. one created in another timezone, or an imported `Z` event) now sits on the correct gridline AND its label matches its position — user/cmux.

## Follow-ons (separate slices, not this plan)

- **Phase 2b** — branded `TimelineLocalIso` type + retire routine `isoFor()` no-offset strings + normalize signal placements once (spec §3.2 remainder; compile-time enforcement, guard H4). Routines/signals already align in the common case, so this is hardening, lower urgency.
- **Phase 3** — remove `new Date(iso).getHours()` from `TimelineBlock.hhmm`/duration + `nowOffsetPx`; labels/durations via the string helpers. Hardens the Phase-2 fix so it cannot regress via the `new Date` path.
- **Phases 4–5** — `planTimelineDrag` single planner; `LayoutBox` semantic/visual/hit split (the drag-handle bug fixes).
