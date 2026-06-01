# G3-PR2c — 프로젝트 divergence 해소 (pull / push / diff)

작성일: 2026-06-01 · 상태: design (approved) · ADR: [0006](../../adr/0006-skills-registry-full-manager.md)
선행: G3-PR2(divergence 감지, divergence.rs) · G3-PR2b(프로젝트 카피 vendoring, vendor.rs)

## 1. 문제 / 기대 영향

G3-PR2b는 중앙 managed 스킬을 프로젝트 dir(`.claude|.codex/skills/<name>`)에 **복사**하고,
G3-PR2는 그 카피가 중앙과 바이트 동일한지(`InSync` / `Diverged`) **감지**한다. 그러나 카피가
`Diverged`되면(둘 중 한쪽 편집) 사용자가 할 수 있는 건 "변경됨" 표시를 보는 것뿐이다 —
**해소 경로가 없다**. unvendor는 InSync일 때만 동작하므로(사용자 편집 무손실) diverged 카피는
교착 상태가 된다.

PR2c는 #22의 **substantive write 슬라이스**: diverged 카피를 양방향 중 하나로 해소한다.

- **diff** — diverged 카피와 중앙의 트리 차이를 읽어서 보여준다(added / removed / changed 라인).
- **pull** — 중앙 내용으로 프로젝트 카피를 덮어쓴다(프로젝트 편집 버림). git-tracked 카피라
  사용자의 git이 undo다.
- **push** — 프로젝트 편집을 중앙에 반영한다(중앙 덮어쓰기). 중앙은 git-tracked가 아니므로(app_data)
  **push 전에 중앙을 backup 스냅샷으로 떠서** 가역성(레일 ①)을 보장한다.

기대 영향: 프로젝트 vendored 스킬의 양방향 동기화가 완성된다 — vendor(복사) → diverge(감지) →
resolve(pull/push)의 마지막 조각. G3-PR3(헬스 배지)만 남고 G3/스킬 매니저 마이그레이션이 끝난다.

## 2. 승인된 설계 결정 (2 forks)

1. **whole-tree pull/push** — per-file 선택이나 3-way merge가 아니라 트리 단위 덮어쓰기. PR2의
   2-way·no-baseline 모델과 일관(누가 편집했는지 추적 안 함). diff는 **표시 전용**(어느 라인을 가져갈지
   고르는 UI 아님).
2. **push는 중앙을 먼저 스냅샷** — `backup_library_core` 재사용. pull은 git-tracked 프로젝트 카피를
   덮으므로 사용자 git이 undo지만, push는 git-untracked 중앙(app_data)을 덮으므로 우리가 스냅샷을
   떠야 가역(레일 ①: 사용자 발동·**가역**·감사).

## 3. 아키텍처 — 새 모듈 `skills/resolve.rs` (vendor.rs 미러)

PR2b vendor.rs가 확립한 패턴을 그대로 따른다: 앱 핸들 비의존 core(tempdir hermetic) + 얇은
`#[tauri::command]` 래퍼. 경로 의미는 vendor.rs·divergence.rs와 **동일 헬퍼**로 도출(C6 단일 출처).

### 재사용 (승격 필요)

| 심볼 | 현재 | 조치 |
|---|---|---|
| `divergence::collect_tree` / `TreeEntry` | private | **pub(crate)** 승격 — diff가 두 트리 맵을 비교 |
| `divergence::trees_equal` | 이미 pub(crate) | 그대로(멱등/InSync 게이트) |
| `vendor::vendorable_repo_root` | private | **pub(crate)** 승격 — 프로젝트 dir 도출 |
| `central_repo::{copy_dir_shallow, central_skill_dir, provider_segment, sanitize_segment}` | pub(crate) | 그대로 |
| `backup::{backup_library_core, backups_root, new_snapshot_id}` | core는 pub(crate), `backups_root`/`new_snapshot_id`는 private | 뒤 둘 **pub(crate)** 승격 — push 커맨드가 사전 스냅샷 |
| `apply::central_root` | pub(crate) | 그대로 |
| `scan::vendor_subdir` | pub(crate) | vendorable_repo_root 내부에서 이미 사용 |

`TreeEntry`는 `#[derive(PartialEq, Eq)]`만 있다 — diff용 텍스트 추출 헬퍼를 resolve.rs에 둔다
(`entry_text`), `TreeEntry`에 메서드를 더하지 않는다(divergence.rs는 비교 전용으로 유지).

### 모델 (models/skills.rs, SkillDivergence 옆)

```rust
/// 프로젝트 카피 ↔ 중앙 트리 차이(G3-PR2c, #22 — 표시 전용). 디스크 유도·비영속(#7). relPath는
/// 표시·매칭 전용 — 로그 금지(C7). 텍스트는 UTF-8 lossy(바이너리 aux는 깨질 수 있으나 표시 전용).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillDiff {
    /// 프로젝트에만 있는 상대경로(중앙 대비 추가됨).
    pub added: Vec<String>,
    /// 중앙에만 있는 상대경로(프로젝트가 지움).
    pub removed: Vec<String>,
    /// 양쪽에 있으나 내용이 다른 파일.
    pub changed: Vec<ChangedFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub rel_path: String,
    pub central_text: String,
    pub project_text: String,
}
```

`i32`/`i64` PK 이슈 없음(전부 String/Vec). bindings는 가산(+2 type, +3 command).

### core 함수

```rust
// 두 트리의 차이(표시 전용). 한쪽이라도 읽기 실패 → AppError(read failure).
pub(crate) fn diff_core(central_dir: &Path, project_dir: &Path) -> Result<SkillDiff, AppError>
```
- `collect_tree(central)` / `collect_tree(project)` → 둘 다 Some 아니면 `skills.resolve.read` 에러.
- 키 합집합 순회:
  - central에만 → `removed.push(rel)`
  - project에만 → `added.push(rel)`
  - 양쪽: `TreeEntry`가 같으면 skip(equal). 다르면 `changed.push(ChangedFile{ rel, entry_text(central), entry_text(project) })`.
- `entry_text(&TreeEntry) -> String`: `File(b)`→ UTF-8 lossy, `Symlink(p)`→ 타깃 경로 문자열, `Dir`→ `""`.
  (프로젝트 카피·중앙은 구성상 심링크-free라 현실적으로 File 변경 + dir add/remove만 발생. 타입 mismatch는
  한쪽 텍스트가 비어 라인 diff에서 전체 추가/삭제로 자연 표현 — magic string 없음.)
- `added`/`removed`/`changed` 각각 정렬(BTreeMap 순회라 이미 결정적).

```rust
// 중앙 → 프로젝트 카피 덮어쓰기(프로젝트 편집 버림). 가역: git-tracked 카피 = 사용자 git이 undo.
pub(crate) async fn pull_core(pool, central_root, project_skill_root, provider, name) -> Result<(), AppError>
```
- `src = central_skill_dir(...)`. `!src/SKILL.md` → `CODE_NO_SOURCE`(동기화 원본 없음 — 거부).
- `dst = project_skill_root.join(sanitize_segment(name))`.
- `dst`가 심링크 → `CODE_NOT_OURS`(사용자 심링크 안 건드림). 부재 → 그대로 진행(생성).
- `trees_equal(dst, src)` → 멱등 no-op(audit 안 함).
- 아니면: `dst` 존재 시 `remove_dir_all`, `create_dir_all`, `copy_dir_shallow(src, dst)`, `audit("pull", "project_dir", dst, src, "copy")`.

```rust
// 프로젝트 카피 → 중앙 덮어쓰기. **커맨드가 호출 전 backup_library_core로 중앙 스냅샷**(가역).
pub(crate) async fn push_core(pool, central_root, project_skill_root, provider, name) -> Result<(), AppError>
```
- `dst = project_skill_root.join(seg)`. 심링크 → `CODE_NOT_OURS`. 부재 → `CODE_NOT_VENDORED`(밀 게 없음).
- `central = central_skill_dir(...)`. `!central/SKILL.md` → `CODE_NO_SOURCE`(managed 아님 — 신규 생성 아님, 거부).
- `trees_equal(dst, central)` → 멱등 no-op(audit 안 함).
- 아니면: `central` 존재 시 `remove_dir_all`, `create_dir_all`, `copy_dir_shallow(dst, central)`, `audit("push", "skill_library", central, dst, "copy")`.

### 커맨드 (resolve.rs)

```rust
#[tauri::command] list_skill_diff(db, app, repo_id, provider, name) -> SkillDiff
#[tauri::command] pull_divergence(db, app, repo_id, provider, name) -> ()
#[tauri::command] push_divergence(db, app, repo_id, provider, name) -> ()
```
- 셋 다: `central = apply::central_root(&app)`, `repos = fetch_all_repos`, `root = vendorable_repo_root(repos, repo_id, provider)`.
- `list_skill_diff`: `diff_core(central_skill_dir(central, seg(provider), san(name)), root.join(san(name)))`.
- `pull_divergence`: `pull_core(&db, &central, &root, provider, &name)`.
- `push_divergence`: **먼저** `backup_library_core(&db, &central, &backups_root(&app)?, &new_snapshot_id())` (사전 스냅샷 = 가역) → 그 다음 `push_core(...)`. (UI는 diverged에서만 push 노출하므로 no-op push 시 잉여 스냅샷은 사실상 도달 불가 — 비용 무시, 가역성 우선.)

등록: `lib.rs` collect_commands! vendor 커맨드 뒤(~266). `skills/mod.rs` `pub mod resolve;` + `pub use resolve::{list_skill_diff, pull_divergence, push_divergence};`.

## 4. 프런트엔드

### 훅 (lib/query/skills.ts)

- `useSkillDiff(args, enabled)` — `useQuery(["skillDiff", repoId, provider, name], …, { enabled })`. 사용자가 "해소…"를 펼칠 때만 fetch(diverged 카피 트리 읽기).
- `usePullDivergence()` — mutation. onSuccess: `skillDivergences` + `skillWorkspaces` + `skills` 무효화.
- `usePushDivergence()` — mutation. onSuccess: 위 셋 + `skillBackups` 무효화(push가 스냅샷 생성).

### VendorPanel (SkillsView.tsx)

- `t.state === "diverged"`의 "변경됨" span → **"해소…" 토글 버튼**. 펼치면 인라인 패널(중첩 Sheet/Dialog
  금지 — Esc 계약 보존, shadcn-migration §overlay-stack):
  - `useSkillDiff` 결과로 added/removed 파일명 목록 + changed 파일별 `lineDiff(centralText, projectText)`를
    기존 `SkillPromptDiff` 렌더러로 표시(중앙=base, 프로젝트=current → add=프로젝트가 추가, remove=프로젝트가 지움).
  - 두 인라인 액션(각각 2-step confirm = 클릭 → "확인?" → 실행):
    - **"중앙으로 되돌리기(pull)"** — 프로젝트 편집 버리고 중앙 내용으로. 위험: 프로젝트 편집 손실(단 git-tracked).
    - **"중앙에 반영(push)"** — 프로젝트 편집을 중앙으로. 사전 백업 안내 문구.
  - 성공/실패는 기존 `note` 패턴 재사용.

## 5. INVARIANT 체크 (decision-rails 7)

- **#1/#2 (잡 spawn 0)** — 파일 복사/제거 + DB audit/backup뿐. codex 잡 비취급. ✅
- **#7 (무마이그레이션)** — 상태는 디스크 유도. 새 표/마이그레이션 없음. ✅
- **레일 ① (사용자 발동·가역·감사)** — pull/push 전부 사용자 발동, audit 기록, push는 사전 스냅샷으로 가역,
  pull은 git-tracked 카피라 git이 undo. 충돌(심링크)은 거부(덮어쓰지 않음). ✅
- **외부 네트워크/토큰** — 없음(로컬 fs). ✅
- **AppError 단일 envelope** — 전부 `Result<_, AppError>`. ✅
- **C6 경로 단일 출처** — vendorable_repo_root/central_skill_dir 재사용. ✅
- **C7 로그 금지** — 경로/내용 로그 안 함. ✅

## 6. 검증 (done-criteria)

- `cargo test`(resolve.rs core 테스트: diff added/removed/changed·pull overwrite/idempotent/symlink-refuse/no_source·
  push overwrite/idempotent/symlink-refuse/absent/no_source·push 커맨드 backup 생성) + `clippy -D warnings` + `fmt`.
- `pnpm typecheck` + `lint` + `vitest`(useSkillDiff 훅·diff 렌더 분기는 기존 buildVendorTargets 테스트 옆에).
- `git diff src/bindings.ts` = +2 type / +3 command만(가산, 삭제 0).
- 독립 opus critic(별도 컨텍스트, 전체 PR) ACCEPT 0 블로커.

## 7. 위험 / 롤백

- **pull 데이터 손실**: 프로젝트 편집을 버린다 — git-tracked라 `git checkout`으로 복구. 2-step confirm로 가드.
- **push 중앙 오염**: 사전 backup 스냅샷 → 백업/복원 패널에서 되돌림. 2-step confirm로 가드.
- 바이너리 aux 파일: diff 텍스트가 lossy로 깨질 수 있으나 **표시 전용** — pull/push는 바이트 단위 복사라 무손실.
- 롤백: 모듈/커맨드 신규 추가라 revert = 파일 삭제 + lib.rs/mod.rs/models 3줄 되돌림.

## 8. deferred (비차단)

- per-file 선택 / 3-way merge(YAGNI — 2-way 모델 유지).
- 0-스킬 프로젝트, per-location attribution.
- 라이브 `pnpm tauri dev` 스모크(이 브랜치 미부팅 — dev-DB skew 위험). 유닛/critic 검증만.
