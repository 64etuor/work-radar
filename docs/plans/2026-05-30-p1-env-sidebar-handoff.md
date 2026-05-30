# P1 실행 핸드오프 — 환경 감지 사이드바 (다음 세션 시작점)

작성 2026-05-30. P0(멀티루트 스캔 토대) 완료 직후. 다음 세션 AI가 별도 맥락 없이 **바로 P1을 구현**할 수 있도록 작성.

> **정본 플랜**: `docs/plans/2026-05-29-skills-manager-migration.md` **Phase 1**.
> **결정 근거**: `docs/adr/0006-skills-registry-full-manager.md` (풀 매니저, P1은 viewer 네비).
> **선행 P0 핸드오프**(완료된 토대): `docs/plans/2026-05-30-p0-multiroot-scan-handoff.md`.
> 충돌 시 플랜 Phase 1이 정본.

## 0. 현재 상태 (git — 정본)

- **origin/dev = `b7dd89f`** ← P0(멀티루트 스캔) push 완료. PR1(`a53449a`)·문서/ADR-0006(`f752815`)도 dev에 있음.
- **워크트리 `.claude/worktrees/skills-mgr-migration`** = 브랜치 `feat/skills-mgr-migration` @ `b7dd89f` (clean, == origin/dev). **← 여기서 작업.**
- ⚠️ **메인 트리 `/Users/davidpark/private_project/work-radar`의 로컬 `dev`는 아직 `f752815`(origin/dev보다 1커밋 뒤처짐).** P0는 feat 브랜치 push로 origin/dev에 올라갔고 로컬 dev ref는 안 움직였다. 다음 세션은 **feat 워크트리(b7dd89f)에서 작업**하거나 메인트리에서 `git pull` 후 시작.
- 무관 워크트리: `.claude/worktrees/overlay-stack-ssot`(overlay-stack 리팩터), `~/.config/superpowers/worktrees/work-radar/hermes-floating`(hermes 피처). **건드리지 말 것.**

## 1. P0가 깔아둔 토대 (P1이 쓰는 것)

P0(`b7dd89f`, `src-tauri/src/`)가 이미 제공:

- `models/skills.rs`: `enum SkillProvider { Claude, Codex, Openclaw, Hermes, Other }` (specta → TS `"claude"|"codex"|...`), `Skill.provider: Option<SkillProvider>`(외부=Some, 인앱=None), `ExternalSkill.provider`.
- `commands/skills.rs`:
  - `skill_roots() -> Vec<(SkillProvider, PathBuf, bool)>` — **단일 ROOTS 출처**(claude/codex/`.agents`/openclaw). **P1의 detect도 이걸 재사용**(새 ROOTS 만들지 말 것 — C6 단일 출처).
  - `scan_external_skills_core(roots)` — 멀티루트 스캔, provider 태깅.
  - `list_skills_core(db, roots)` / `list_skills` 커맨드 — 외부 행에 `provider` 실림.
  - `ensure_within_skills_dir_roots(path, roots)` — 일반화 path-guard.
- `src/bindings.ts`: `SkillProvider` union + `Skill.provider: SkillProvider | null` 노출됨. **프런트는 이제 백엔드 provider를 쓸 수 있다.**

## 2. P1이 바꾸는 것 (Deliverables — 플랜 Phase 1)

1. **신규 커맨드 `detect_skill_environments`** (`commands/skills.rs`): P0에서 **의도적으로 P1로 이관(C4)**. 동일 `skill_roots()` + provider 태깅된 스캔에서 도출. 환경별 `{provider, present: bool, skill_count}` 반환. 사이드바가 유일 소비자라 여기서 신설. `list_skills`/`scan_external_skills_core`를 재사용(roots 주입 → hermetic 테스트).
   - ⚠️ **개정(2026-05-30)**: detect는 **하드코딩 ROOTS 재사용이 아니라 env-aware 루트 resolution**이 돼야 함(`CODEX_HOME`/`XDG_CONFIG_HOME` 등 → dotfile 폴백). 사용자가 Hermes/중첩 스킬 누락을 발견 → **위치(경로 다르면 못 찾음) + 깊이(비재귀라 중첩 누락)** 두 축. 재귀·Hermes 루트·레포-로컬/사용자 루트는 **신규 Phase 1.5**로 분리. 정본: plan **Phase 1·1.5**(이 핸드오프보다 우선).
   - `lib.rs`의 `collect_commands![]`에 **새 커맨드 등록 필요**(`src-tauri/src/lib.rs:238` 근처 skills 커맨드들 옆). P0와 달리 새 `#[tauri::command]`라 등록 필수 → bindings 재생성.
2. **SkillsView 좌측 env 사이드바** (`src/components/SkillsView.tsx` + `SkillsView.css`): skills-manager `Sidebar.tsx` 그룹 구조 차용 → **"All"(집계) + 감지된 환경 그룹만**(detect dir 존재 시에만 렌더 — OpenClaw 없으면 섹션 X). PR1에서 사이드바 클래스는 제거됐으니 **재도입**.
3. **카운트 배지** = `enabled/total` (기존 `segmentSkills`의 health 재사용).
4. **사이드바 선택 → 메인 카드 필터** (그 환경으로). "All" = 전 환경 집계.
5. **프런트 `providerOf()` 제거** (`SkillsView.tsx:209`) → P0 백엔드 `Skill.provider` 사용. `segmentSkills`(`SkillsView.tsx:217`)의 `providerOf(s) === "codex"` 등을 `s.provider === "codex"`로 교체.
6. **사이드바 드래그 재정렬**(#14): 항목 로컬 순서(localStorage), 외부 상태 변경 없음.

## 3. Done-criteria (플랜 Phase 1)

- 설치된 환경만 사이드바 노출(스모크: `~/.openclaw` 없음 → OpenClaw 그룹 미노출).
- Claude/Codex 카운트 정확, All 집계 = 합.
- `detect_skill_environments` hermetic 테스트(tempdir roots 주입 — P0 테스트 패턴 그대로).
- `pnpm typecheck`/`lint`/`vitest run` green + `cargo test` + bindings drift 0.

## 4. 검증 명령 (정본 = `docs/reference/commands.md`)

```bash
export PATH="$HOME/.cargo/bin:$PATH"   # cargo 기본 PATH 부재(husky pre-commit도 cargo fmt)
cargo test  --manifest-path src-tauri/Cargo.toml                         # + bindings.ts 재생성
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt   --manifest-path src-tauri/Cargo.toml --check
pnpm typecheck && pnpm lint && pnpm vitest run
git diff --exit-code src/bindings.ts                                     # drift 0 (CI 게이트)
```

> **rtk 도구 주의(실측)**: 이 환경에서 rtk-wrapped cargo는 **exit code·파이프 출력을 mangle**한다. `| tail`/`| cat`로 받은 cargo 출력과 "exit 0" 요약을 신뢰하지 말 것. **결과는 `> /tmp/x.txt 2>&1`로 파일 리다이렉트 후 Read 도구로 확인**. (`docs/areas/shell-tooling.md`)

## 5. 레일 / 주의 (P1에서 지킬 것)

- **읽기 전용 유지**(P1도 viewer — 외부 dir 무쓰기, 비실행). 외부 dir 쓰기/설치는 Phase G.
- **no-PII 로깅**: detect 로그도 provider+count만. 절대경로/frontmatter 금지(C7, AGENTS.md).
- **single ROOTS**: detect는 P0 `skill_roots()` 재사용. 두 번째 ROOTS 정의 금지(C6).
- **self-approve 금지**: P1 완료 시 critic/verifier 별도 패스로 INVARIANT 7개 무위반 확인.
- **`.agents/skills` = Codex 태깅**(P0 유지). Copilot 도입 시 P1에서 `.agents` 귀속 재검토 — 했으면 `decisions.md` breadcrumb.
- **bindings 수기 편집 금지** — `cargo test`가 생성. drift=CI 게이트.

## 6. P0 breadcrumb (다음에 잃기 쉬운 암묵지)

- `#[sqlx(default)]`는 컴파일 실패(FromRow가 Decode 바운드 요구) → `Skill.provider`는 **`#[sqlx(skip)]`**(항상 Default=None; 외부 행은 `list_skills_core`가 직접 세팅). detect도 DB 비영속이면 동일 주의.
- 심링크 스킬 dir 수용(`is_dir() || is_symlink()`)·심링크 타깃 **canonicalize 안 함**(가드 lexical starts*with) — G의 *프로그램적\_ 쓰기 전 재검토(P1 무관).
- critic nit: 플랜의 `tool_adapters.rs:189` 인용은 stale(파일 부재) — P1 landing 시 정정 가능.
- radix Esc gotcha(Sheet `onEscapeKeyDown` stopPropagation) — P1에서 사이드바/필터 추가 시 overlay-stack 마커 계약 깨지 말 것. cmux/Playwright Esc 스모크.

## 7. 다음 (P1 완료 후)

P2(표현: md 렌더 + 커맨드 팔레트 점프 + Help 다이얼로그 — PR1 카드/Sheet는 이미 완료). 의존: P1.
