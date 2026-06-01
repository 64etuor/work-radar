# G3-PR1 — 프로젝트 워크스페이스 뷰(읽기 전용) 설계

- **날짜**: 2026-06-01
- **Phase**: G3 (프로젝트 워크스페이스 + 양방향 sync), 첫째 PR — #16 프로젝트 워크스페이스(뷰 전용)
- **ADR**: [0006](../../adr/0006-skills-registry-full-manager.md) — 레일 ② (중앙 라이브러리 = managed SSOT, discovered는 디스크-SSOT 읽기 전용)
- **선행**: P0(스캔)·P1(env 네비)·P1.5(레포-로컬 루트 스캔 = `repo_skill_roots`) — dev 완료. G2(외부 dir 적용) 로컬 완료(미푸시).
- **상태**: 설계 승인됨 → 구현 계획 대기

## 문제와 기대 영향

스킬 뷰는 현재 스킬을 **provider 축**(claude/codex/openclaw/hermes/other + 인앱)으로만
그룹핑한다. 그런데 `repo_skill_roots()`는 **이미** 각 enabled `Local` 레포의
`<local_path>/{.claude,.codex,.agents}/skills`를 재귀 스캔해 레포-로컬 스킬을 발견하고 있다 —
다만 그 결과가 평면 목록에 provider별로만 섞여 들어갈 뿐 **어느 프로젝트의 스킬인지로 묶이지
않는다**.

G3-PR1은 **프로젝트 축**을 사이드바에 추가한다: enabled `Local` 레포마다 워크스페이스 항목을
두고, 선택하면 그 프로젝트의 스킬만 필터링해서 본다. **순수 읽기 전용** — 새 스캔도, 외부 dir
쓰기도, 마이그레이션도 없다. 이미 스캔되는 데이터를 **프로젝트 단위로 집계·표면화**할 뿐이다.

기대 영향: 사용자가 "이 레포에는 어떤 스킬이 있나"를 한눈에 보고, 프로젝트별로 스킬을
탐색할 수 있다. #17(sync 헬스 배지)와 #22(양방향 sync)가 올라설 P1-사이드바 토대가 된다.

## 비목표 (이 PR 범위 밖, 명시적 defer)

- **프로젝트별 적용/해제(쓰기 경로)** — 중앙 managed 스킬을 `<repo>/.claude/skills`에 적용. 드리프트
  모델(심링크 기본·복사 opt-in)은 확정됐으나, 본 PR은 **뷰 전용**이므로 쓰기 경로는 다음 PR로 defer.
- **양방향 sync 엔진(#22)** — 중앙↔프로젝트 divergence 감지·해소. 별도 PR(복사 경로 도입과 함께).
- **sync 헬스 배지(#17)** — diverged/in-sync 점. #22 위에 서므로 그 다음 PR. 본 PR의 "health"는
  단순 스킬 수(`skillCount`)일 뿐 sync 상태가 아니다.
- **work-radar `projects` 표(노션/캘린더 그룹)와의 통합** — G3의 "프로젝트"는 `Repo.local_path`
  의미(코드 레포 체크아웃)지 `projects` 표가 아니다. 본 PR은 `repos`만 읽는다.
- **github(remote-only) 레포·비활성 레포** — 로컬 체크아웃이 없으므로 워크스페이스 대상 아님
  (`repo_skill_roots`의 기존 필터와 동일: `Provider::Local && enabled`).

## 모델 (결정 요약)

브레인스토밍에서 확정된 것:

1. **Design B — 백엔드 집계.** 워크스페이스 멤버십을 **Rust(`scan.rs`)에서 계산**한다. 프런트는
   경로 추론을 하지 않는다 — 코드베이스가 의도적으로 폐기한 프런트 경로추론(구 `providerOf`)
   안티패턴을 재도입하지 않기 위함이며, 루트/경로 의미(`.claude/skills`·재귀·정규화)의 단일
   출처를 scan.rs에 유지한다(C6).
2. **사이드바 섹션.** 별도 top-level 뷰 토글이 아니라 기존 환경 사이드바에 "프로젝트" **섹션을
   추가**한다(가장 작은 변경, 기존 nav/필터/세그먼트 렌더 재사용).
3. **읽기 전용.** 새 표·마이그레이션·캐시 없음 — 멤버십은 매 호출 디스크 스캔에서 유도한다
   (환경 detect와 동일, INVARIANT #7 유지).

## 백엔드 (`src-tauri/src/skills/scan.rs` + `models/skills.rs`)

새 read-only 커맨드 + 타입 1개. PK 미노출 → specta 안전(i64 이슈 없음). bindings 추가 =
커맨드 1개 + 타입 1개(가산 drift).

```rust
/// enabled Local 레포 1개 = 프로젝트 워크스페이스. DB 비영속(매 호출 디스크 스캔). 읽기 전용 —
/// 외부 dir에 쓰지 않는다. `rootPath`는 표시 전용(주 루트) — 로그 금지(C7).
pub struct SkillWorkspace {
    repo_id: String,            // repos.id (표시·nav id용 — String이라 specta 안전)
    label: String,              // local_path의 basename(표시 전용)
    root_path: String,          // local_path(표시 전용 — 로그 금지)
    skill_count: i32,           // 이 레포 스킬 dir들에서 발견한 스킬 수(specta i64 미지원 → i32)
    member_paths: Vec<String>,  // 각 멤버 스킬의 source_path → FE 필터 Set(프런트 경로추론 회피)
}
```

> **`enabled_count` 의도적 제외**: 외부 스킬은 `list_skills`가 항상 `enabled: true`로 합성한다
> (registry.rs — 외부는 디스크 SSOT라 우리 DB로 토글 불가). 워크스페이스는 외부 스킬만 집계하므로
> `enabled_count`는 항상 `skill_count`와 같다 → 중복 필드라 제외(YAGNI). health = `skill_count`.

### 코어 (앱 핸들 비의존 → tempdir hermetic, 기존 scan 패턴)

```text
list_skill_workspaces_core(repos: &[Repo]) -> Vec<SkillWorkspace>
```

- 입력 `repos`에서 `Provider::Local && enabled && local_path 비어있지 않음`만 통과(기존
  `repo_skill_roots` 필터와 동일 술어 — 재사용 가능하면 재사용).
- 각 레포: 그 레포의 `repo_skill_roots`(= `<local_path>/{.claude,.codex,.agents}/skills` 재귀 루트)를
  `scan_external_skills_core`로 스캔 → 발견된 `ExternalSkill`들의 `path`를 `member_paths`로,
  개수를 `skill_count`로 집계.
- **스킬 0개 레포는 결과에서 제외**(확정). 뷰 전용 PR에서 빈 프로젝트는 적용 타깃이 없어 노이즈일
  뿐이다(환경 detect의 "present면 노출"과 다른 정책 — 환경은 도구 설치 자체가 의미 있지만, 스킬
  0개 코드 레포는 이 뷰에서 보여줄 게 없다). 프로젝트별 적용(쓰기 경로)이 들어오는 후속 PR에서
  빈 프로젝트도 타깃이 되면 그때 포함 정책을 재검토한다.
- `label` = `local_path`의 마지막 경로 세그먼트(basename). 빈 경우 `local_path` 전체로 폴백.
- **graceful**: 개별 레포 스캔 실패는 그 레포만 건너뛰고 계속(읽기 전용·안전).

### 커맨드 (얇은 래퍼)

```text
list_skill_workspaces(db) -> Result<Vec<SkillWorkspace>, AppError>
```

`fetch_all_repos(db)`로 레포를 읽어 코어에 위임(별도 repos-fetch 커맨드를 FE에 노출하지 않는다 —
워크스페이스 집계는 백엔드 내부에서 완결). **레포 read 실패는 `AppError`로 노출**(확정) — 본
커맨드는 명시적 사용자 액션이고, 빈 vec로 조용히 degrade하면 진짜 DB 실패를 "프로젝트 없음"으로
숨긴다. (대조: `skill_roots_db`는 백그라운드 스캔 합성이라 graceful degrade가 맞지만, 여기는
포그라운드 조회다.) 개별 레포 _스캔_ 실패는 그 레포만 건너뛰고 계속(위 코어의 graceful) — DB read
실패와 구분된다. 커맨드 추가 → bindings는 `cargo test`로 재생성(GUI 부팅 불요).

## FE (`SkillsView.tsx` / `skillEnvNav.ts`)

가산 변경 — 기존 provider 환경 사이드바·세그먼트 렌더는 유지(병렬 시스템 신설 아님).

- `useSkillWorkspaces` 쿼리 훅(`list_skill_workspaces`).
- 사이드바에 **"프로젝트" 섹션** 추가(환경 섹션 아래). 워크스페이스마다 nav 항목
  `workspace:${repoId}`, `match(skill) = memberPaths.has(skill.sourcePath)` — **TS 경로 로직 0**,
  백엔드가 준 멤버십 Set lookup만.
- 워크스페이스 선택 시 스킬 목록을 그 프로젝트로 필터(선택 nav의 `match` 적용). 필터 안에서
  기존 provider 세그먼트·카드는 그대로 렌더.
- 섹션/항목 "health" = `skillCount`(스킬 수만 — 외부 스킬은 항상 enabled라 분수 무의미; sync 배지 아님).
- 빈 경우(워크스페이스 0): 프로젝트 섹션 미렌더(graceful).
- `SkillEnvNavId` 타입에 `workspace:${string}` 변종 추가(기존 `"all" | "in_app" | provider:${...}`
  확장). 정렬/순서 영속(`applyEnvOrder`)이 새 id를 깨지 않는지 plan에서 확인.
- shadcn/lucide 온스택, `DESIGN.md`(Cohere white editorial) 준수. 중첩 Dialog 없음(인라인 사이드바
  → Sheet Esc 계약 무관).

## 테스트 (TDD, hermetic tempdir)

1. **집계 정확**: tempdir에 가짜 레포 2개(레포A: `.claude/skills/x` + `.codex/skills/y`, 레포B:
   `.claude/skills/z`) → 워크스페이스 2개, 각 `member_paths`/`skill_count` 정확.
2. **필터 술어**: enabled 아님 레포·`Provider::Github` 레포·`local_path` 빈 레포 → 결과에서 제외.
3. **빈 워크스페이스 제외**: 스킬 0개 레포(스킬 dir 부재 또는 dir은 있으나 스킬 0) → 결과 미포함.
4. **label basename**: `local_path=/a/b/myrepo` → `label="myrepo"`.
5. **graceful**: 한 레포 스캔 실패 주입 시 나머지 레포는 정상 집계(중단 안 함).
6. **FE 멤버십**: `buildSkillEnvNav`(또는 신설 워크스페이스 nav 빌더)가 백엔드 리스트로 nav 항목
   생성·`match`가 `memberPaths` Set 사용·워크스페이스 0이면 섹션 미생성.

## 위험·롤백·마이그레이션

- **마이그레이션 없음**(상태는 디스크 유도). 롤백 = 커밋 revert(읽기 전용이라 부수효과 0).
- **#1/#2 불변**: 읽기 전용 — 잡 spawn/실행 경로 없음.
- **INVARIANT #7**: 새 영속 상태 없음(디스크 SSOT, 환경 detect와 동일).
- **C6/C7**: 루트/경로 로직은 scan.rs에 유지(프런트 경로추론 0); `root_path`는 표시 전용·로그 금지.
- 외부 dir 쓰기 표면 **0**(뷰 전용) — G3의 쓰기/sync 위험은 후속 PR로 격리.

## 검증 (commands.md 인덱스)

`cargo test`(바인딩 재생성) · `cargo clippy --all-targets -- -D warnings` · `cargo fmt --check` ·
`pnpm typecheck` · `pnpm lint` · `pnpm vitest run` ·
`git diff --exit-code src/bindings.ts`(가산 drift = 커맨드 1개 + `SkillWorkspace`만 예상).

독립 opus critic ACCEPT 후에만 done. self-approve 금지. **로컬 커밋만 — 미푸시**(푸시는 사용자
명시 요청 시 별도).
