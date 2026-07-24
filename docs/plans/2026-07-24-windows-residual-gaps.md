# Windows Residual Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make skills apply/unapply work on stock Windows (no Developer Mode) via an NTFS
junction fallback and platform-correct link removal, widen the ntn Notion token import to
Windows paths, and verify on a real Windows runner.

**Architecture:** All changes stay inside the existing seams: `skills/apply.rs` gains a
`#[cfg(windows)]` fallback arm and a platform-correct `remove_link` helper (no new module),
`commands/tokens.rs` gains a pure candidate-path builder next to the existing
`ntn_token_from_file`, and verification reuses the existing manual `windows-compat.yml`
workflow which runs `cargo test` on `windows-latest` (so `#[cfg(windows)]` tests execute
for real there).

**Tech Stack:** Rust 2021, Tauri 2, `junction` crate (Windows-only dep), tokio tests,
GitHub Actions `windows-latest` via `workflow_dispatch`.

## Global Constraints

- Design source of truth: `docs/plans/2026-07-24-windows-residual-gaps-design.md` (Approved).
- ADR-0006 rails: skills ops stay user-invoked, reversible, audit-logged; never touch
  non-ours files; collision = refuse, never overwrite.
- No behavior change on macOS/Linux — all new behavior is `#[cfg(windows)]`.
- Tokens keychain-only; token bodies never returned over IPC.
- Out of scope: Boule (owner will remove it later), cmux/Hermes (stay gated), automatic CI
  triggers (manual dispatch only), Windows code signing/release.
- Shell caveats: run cargo with `export PATH="$HOME/.cargo/bin:$PATH"`; run cargo from
  `src-tauri/` explicitly; do not pipe cargo output (`| head` swallows exit codes).
- `cargo test` regenerates `src/bindings.ts` → always re-run `pnpm typecheck` last.
- Commit per task (Conventional Commits). Do NOT push without explicit user approval.

---

### Task 1: Platform-correct link removal (`remove_link`)

Windows removes directory symlinks/junctions with `RemoveDirectory`, not `DeleteFile` —
today's `std::fs::remove_file(&link)` in `unapply_core` fails on Windows even for plain
directory symlinks. Fix independently of the junction work.

**Files:**

- Modify: `src-tauri/src/skills/apply.rs` (unapply_core, ~line 176)

**Interfaces:**

- Produces: `fn remove_link(link: &Path) -> std::io::Result<()>` (private helper in
  `apply.rs`), used by `unapply_core`. Task 2 relies on it removing junctions too.

- [ ] **Step 1: Add the helper + switch the call site**

In `src-tauri/src/skills/apply.rs`, below `make_symlink`, add:

```rust
/// 링크 제거(크로스플랫폼). unix 심링크는 파일로, Windows 디렉터리 심링크/junction은
/// 디렉터리 reparse point라 `remove_dir`로 지운다(타깃 내용은 건드리지 않음).
#[cfg(unix)]
fn remove_link(link: &Path) -> std::io::Result<()> {
    std::fs::remove_file(link)
}
#[cfg(windows)]
fn remove_link(link: &Path) -> std::io::Result<()> {
    std::fs::remove_dir(link)
}
```

In `unapply_core`, replace:

```rust
    std::fs::remove_file(&link)
        .map_err(|e| AppError::terminal("skills.apply.unlink", format!("심링크 제거 실패: {e}")))?;
```

with:

```rust
    remove_link(&link)
        .map_err(|e| AppError::terminal("skills.apply.unlink", format!("심링크 제거 실패: {e}")))?;
```

- [ ] **Step 2: Run existing unapply tests on macOS (regression guard)**

Run:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test skills::apply
```

Expected: all existing `apply`/`unapply` tests PASS (unix arm unchanged).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/skills/apply.rs
git commit -m "fix(skills): Windows 디렉터리 링크 제거를 remove_dir로 — unapply 크로스플랫폼 정합"
```

### Task 2: Junction fallback for privilege-less Windows

**Files:**

- Modify: `src-tauri/Cargo.toml` (windows target deps)
- Modify: `src-tauri/Cargo.lock` (via cargo)
- Modify: `src-tauri/src/skills/apply.rs` (make_symlink windows arm, is_our_symlink
  compare normalization, `#[cfg(windows)]` tests)

**Interfaces:**

- Consumes: `remove_link` from Task 1.
- Produces: Windows `make_symlink` that transparently falls back to
  `junction::create(target, link)` on `ERROR_PRIVILEGE_NOT_HELD` (os error 1314);
  `fn normalize_for_compare(p: &Path) -> PathBuf` used inside `is_our_symlink`.

- [ ] **Step 1: Add the Windows-only dependency**

In `src-tauri/Cargo.toml`, find the existing `[target.'cfg(windows)'.dependencies]`
section (it holds the `keyring` windows-native entry) and add:

```toml
junction = "1"
```

If the section for plain windows cfg does not exist (keyring may use a narrower cfg),
add:

```toml
[target.'cfg(windows)'.dependencies]
junction = "1"
```

Then refresh the lockfile without building:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo metadata --format-version 1 > /dev/null
```

Expected: `Cargo.lock` gains `junction` (and its `winapi`/`windows-sys` transitive deps).

- [ ] **Step 2: Implement the fallback arm**

In `src-tauri/src/skills/apply.rs`, replace the windows `make_symlink`:

```rust
#[cfg(windows)]
fn make_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    // 1차: 진짜 디렉터리 심링크(개발자 모드/관리자면 성공). 권한 없음(1314)일 때만
    // NTFS junction으로 폴백 — junction은 무권한 생성 가능한 디렉터리 reparse point로,
    // read_link/symlink_metadata/canonicalize가 심링크와 동일하게 취급한다.
    match std::os::windows::fs::symlink_dir(target, link) {
        Err(e) if e.raw_os_error() == Some(1314) => junction::create(target, link),
        other => other,
    }
}
```

- [ ] **Step 3: Normalize path comparison for junction targets**

Junction `read_link`/`canonicalize` output carries the `\\?\` verbatim prefix; broken-link
raw comparison must not fail on the prefix alone. Add below `make_symlink`:

```rust
/// 비교용 경로 정규화 — Windows verbatim prefix(`\\?\`)만 벗긴다(그 외 항등).
#[cfg(windows)]
fn normalize_for_compare(p: &Path) -> PathBuf {
    match p.to_str() {
        Some(s) => PathBuf::from(s.trim_start_matches(r"\\?\")),
        None => p.to_path_buf(),
    }
}
#[cfg(not(windows))]
fn normalize_for_compare(p: &Path) -> PathBuf {
    p.to_path_buf()
}
```

In `is_our_symlink`, replace the two comparisons:

```rust
    if target == expected_central_dir {
```

with:

```rust
    if normalize_for_compare(&target) == normalize_for_compare(expected_central_dir) {
```

and:

```rust
        (Ok(a), Ok(b)) => a == b,
```

with:

```rust
        (Ok(a), Ok(b)) => normalize_for_compare(&a) == normalize_for_compare(&b),
```

- [ ] **Step 4: Add Windows-only junction contract tests**

Append inside `mod tests` in `apply.rs` (these run for real on the `windows-latest`
runner via `cargo test`; on macOS they compile out):

```rust
    /// Windows 전용: junction으로 만든 링크가 심링크와 동일하게 인식·제거되는지
    /// (권한 없는 stock Windows에서 make_symlink가 폴백하는 형태를 직접 재현).
    #[cfg(windows)]
    #[tokio::test]
    async fn junction_link_is_recognized_and_unapplied() {
        let pool = crate::commands::shared::test_support::fresh_db().await;
        let (_t, central, ext, src) = scaffold("foo");
        let link = ext.join("foo");
        junction::create(&src, &link).expect("junction create needs no privilege");

        // 인식: 우리 링크로 판정되고 멱등 재적용이 성공한다.
        assert!(is_our_symlink(&link, &src));
        let again = apply_core(&pool, &central, &ext, SkillProvider::Claude, "foo")
            .await
            .expect("idempotent over junction");
        assert_eq!(again, link);

        // 목록 유도에도 잡힌다.
        let roots = vec![(SkillProvider::Claude, ext.clone())];
        assert_eq!(list_applied_core(&central, &roots).len(), 1);

        // 제거: unapply가 junction을 지우되 중앙 타깃 내용은 무손상.
        unapply_core(&pool, &central, &ext, SkillProvider::Claude, "foo")
            .await
            .expect("unapply junction");
        assert!(std::fs::symlink_metadata(&link).is_err());
        assert!(src.join("SKILL.md").is_file(), "중앙 라이브러리 무손상");
    }

    /// Windows 전용: 끊긴 junction(타깃 삭제 후)도 raw 비교로 우리 것으로 인식된다
    /// (unix 끊긴 심링크 패리티 — 아니면 uninstall이 영구 거부돼 잔해가 남는다).
    #[cfg(windows)]
    #[test]
    fn broken_junction_still_recognized_as_ours() {
        let (_t, _central, ext, src) = scaffold("foo");
        let link = ext.join("foo");
        junction::create(&src, &link).unwrap();
        std::fs::remove_dir_all(&src).unwrap(); // 타깃 삭제 → 끊긴 링크.
        assert!(is_our_symlink(&link, &src));
    }
```

- [ ] **Step 5: Compile-check both targets, run macOS tests**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
rustup target add x86_64-pc-windows-msvc
cd src-tauri && cargo check --target x86_64-pc-windows-msvc
cd src-tauri && cargo test skills::apply
```

Expected: Windows target check PASS (junction arm + tests compile), macOS tests PASS
(behavior unchanged). If `cargo check --target` fails on unrelated system deps (e.g.
webview build scripts), record it verbatim and rely on the CI dispatch in Task 5 —
do not claim it passed.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/skills/apply.rs
git commit -m "feat(skills): 무권한 Windows용 NTFS junction 폴백 — symlink 1314 시 대체 생성"
```

### Task 3: ntn token import path candidates on Windows

**Files:**

- Modify: `src-tauri/src/commands/tokens.rs` (`ntn_token_from_file`, ~line 294; tests)

**Interfaces:**

- Produces: `fn ntn_token_file_candidates(home: Option<PathBuf>, appdata: Option<std::ffi::OsString>) -> Vec<PathBuf>`
  (pure, testable on all hosts); `ntn_token_from_file` iterates candidates in order.

- [ ] **Step 1: Write the failing test**

At the bottom of `src-tauri/src/commands/tokens.rs`, add (or extend the existing
`#[cfg(test)] mod tests` if one exists):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn ntn_candidates_xdg_first_then_appdata() {
        let home = Some(PathBuf::from("/home/u"));
        let appdata = Some(std::ffi::OsString::from("/appdata/Roaming"));
        let got = ntn_token_file_candidates(home, appdata);
        assert_eq!(got[0], PathBuf::from("/home/u/.config/notion/api_key"));
        assert!(got
            .contains(&PathBuf::from("/appdata/Roaming").join("notion").join("api_key")));
    }

    #[test]
    fn ntn_candidates_no_home_no_appdata_is_empty() {
        assert!(ntn_token_file_candidates(None, None).is_empty());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test commands::tokens
```

Expected: FAIL — `ntn_token_file_candidates` not found.

- [ ] **Step 3: Implement candidates + rewire the reader**

Replace `ntn_token_from_file` in `tokens.rs`:

```rust
/// ntn file-auth 후보 경로(우선순위 순). 1) XDG 스타일 `~/.config/notion/api_key`
/// (전 플랫폼 — ntn 기본), 2) Windows에선 `%APPDATA%\notion\api_key`도 시도.
/// 순수 함수로 분리해 전 호스트에서 테스트한다(env는 wrapper가 읽음).
fn ntn_token_file_candidates(
    home: Option<PathBuf>,
    appdata: Option<std::ffi::OsString>,
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = home {
        out.push(home.join(".config").join("notion").join("api_key"));
    }
    if let Some(appdata) = appdata {
        out.push(PathBuf::from(appdata).join("notion").join("api_key"));
    }
    out
}

/// ntn file-auth 위치에서 Notion 토큰을 읽는다. ntn은 비대화식 토큰 emit 서브커맨드가
/// 없어 file-auth 경로를 import 메커니즘으로 쓴다(Phase 14 §14 결정). 첫 번째로 읽히는
/// 후보가 이긴다. 토큰 본문은 여기서만 잠시 다뤄지고 호출부에서 즉시 keychain으로 간다.
fn ntn_token_from_file() -> Option<String> {
    let appdata = if cfg!(windows) {
        std::env::var_os("APPDATA")
    } else {
        None
    };
    for path in ntn_token_file_candidates(platform::home_dir(), appdata) {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            let token = raw.trim().to_string();
            if !token.is_empty() {
                return Some(token);
            }
        }
    }
    None
}
```

(`use std::path::PathBuf;` — confirm the file's existing imports; `Path` is already
imported, add `PathBuf` if missing.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd src-tauri && cargo test commands::tokens
```

Expected: PASS, including the two new tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/tokens.rs
git commit -m "fix(tokens): ntn 토큰 파일 임포트에 Windows APPDATA 후보 경로 추가"
```

### Task 4: Windows smoke checklist + decision log

**Files:**

- Modify: `docs/SETUP.md` (Windows section — around lines 12/24-25/90-92/117)
- Modify: `docs/decisions.md` (append one line)

- [ ] **Step 1: Add the smoke checklist to SETUP.md**

Read the existing Windows notes in `docs/SETUP.md` and append a new subsection under the
Windows material (match surrounding heading level and tone; Korean):

```markdown
### Windows 실기기 스모크 체크리스트

실물 Windows 11 머신에서 첫 부팅 시 아래를 순서대로 확인한다:

1. `pnpm tauri dev` 부팅 — 창 표시, 트레이 아이콘, Ctrl+Space 전역 단축키.
2. 키체인 왕복 — 설정에서 토큰 저장 후 재시작해도 유지(Windows Credential Manager,
   `자격 증명 관리자`에서 `co.kr.mirrorless.workradar` 확인).
3. 스킬 적용 — 개발자 모드 **꺼진** 상태에서 스킬 적용/해제(junction 폴백 검증,
   `dir` 출력에 `<JUNCTION>` 표시).
4. Codex 감지 — npm 전역 설치(`codex.cmd`)가 에이전트 설정에서 감지되는지.
5. mmbak 임포트 — 파일 대화상자에서 `.mmbak` 선택 → 미리보기까지.
6. cmux/Hermes/Boule 패널 — "지원되지 않음" 안내가 뜨고 앱이 정상 동작하는지.
```

- [ ] **Step 2: Append the decision-log line**

Append to `docs/decisions.md` (match its one-line format):

```markdown
- 2026-07-24 Windows 잔여 갭: 스킬 적용은 symlink 실패(1314) 시 NTFS junction 폴백(무권한), 링크 제거는 Windows에서 remove_dir; Boule은 추후 시스템 제거 예정이라 Windows 작업 제외, CI 자동 트리거는 계속 보류(수동 dispatch만).
```

- [ ] **Step 3: Commit**

```bash
git add docs/SETUP.md docs/decisions.md
git commit -m "docs: Windows 실기기 스모크 체크리스트 + 잔여 갭 결정 기록"
```

### Task 5: Full verification (macOS gates + real Windows runner)

**Files:**

- Modify only files already listed if failures are caused by this change.

- [ ] **Step 1: Rust gates (macOS)**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo fmt --check
cd src-tauri && cargo clippy --all-targets -- -D warnings
cd src-tauri && cargo test
```

Expected: all PASS. (Do not pipe output; rtk-wrapped cargo summaries are unreliable —
read full output.)

- [ ] **Step 2: Frontend gates (typecheck last — cargo test regenerated bindings)**

```bash
pnpm lint
pnpm vitest run
pnpm typecheck
```

Expected: all PASS, `git status` shows no unexpected `src/bindings.ts` drift.

- [ ] **Step 3: Windows cross-target check (local)**

```bash
cd src-tauri && cargo check --target x86_64-pc-windows-msvc
```

Expected: PASS. If host toolchain cannot complete it, say so explicitly ("could not
run" ≠ "passed") and rely on Step 4.

- [ ] **Step 4: Real Windows runner — dispatch the manual workflow**

Requires the commits to be on the remote. **Ask the user for push approval first**
(repo rule: no push without explicit request), then:

```bash
git push origin dev
git ls-remote origin dev   # push 검증(rtk push silent-fail 가드)
gh workflow run windows-compat.yml --ref dev
gh run list --workflow=windows-compat.yml --limit 1
gh run watch <run-id> --exit-status
```

Expected: workflow green — this is the real execution of the `#[cfg(windows)]` junction
tests plus full Windows gates. If red, read the failing job log, fix within the files
this plan touches, and re-dispatch.

- [ ] **Step 5: Reviewer pass (no self-approve)**

Dispatch a separate critic/reviewer pass over the final diff checking the 7 INVARIANTS
(`docs/areas/decision-rails.md`) and ADR-0006 reversibility. Address findings before
declaring done.
