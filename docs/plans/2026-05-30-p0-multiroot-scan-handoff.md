# P0 실행 핸드오프 — 멀티루트 스캔 토대 (다음 세션 시작점)

작성 2026-05-30. 다음 세션 AI가 별도 맥락 없이 **바로 P0를 구현**할 수 있도록 작성.

> **정본 플랜**: `docs/plans/2026-05-29-skills-manager-migration.md` Phase 0 (ralplan 컨센서스 APPROVE 스펙).
> **결정 근거**: `docs/adr/0006-skills-registry-full-manager.md` (풀 매니저 채택, P0는 viewer 절반).
> 이 문서는 그 둘의 **실행 지침**이다. 충돌 시 플랜 Phase 0이 정본.

## 0. 현재 상태 (이 워크트리에서 무엇이 됐나)

- 브랜치 `feat/skills-mgr-migration` (worktree `.claude/worktrees/skills-mgr-migration`). HEAD `9161f1d`(PR1).
- **PR1(카드+Sheet, frontend) 완료·커밋됨**(`9161f1d`, 미push).
- **이번 세션에서 커밋 안 된 변경(uncommitted, 문서/계획)**:
  - `docs/adr/0006-skills-registry-full-manager.md` (신규)
  - `docs/plans/2026-05-29-skills-manager-migration.md` (A–F+G 페이즈 재구성 + P0 컨센서스 스펙)
  - `docs/areas/decision-rails.md` (#2·#7 스킬 매니저 경계 주석)
  - `AGENTS.md` (외부 네트워크 룰 + 스킬 매니저 외부 dir 쓰기 룰)
  - `docs/decisions.md` (ADR-0006 breadcrumb)
  - `src-tauri/src/commands/skills.rs` (모듈 헤더 ADR-0006 forward-ref 주석만)
  - 이 핸드오프 문서
- DB 안전: 이전 세션이 치워둔 실 DB는 **원복 완료**(v37, 실데이터 무손상). 추가 조치 불요.

> ⚠️ **선행**: 위 INVARIANT 문구 개정(decision-rails/AGENTS)은 민감 영역. self-approve 금지 →
> 커밋 전 critic/reviewer 별도 패스 권장(이번 세션은 미실행).

## 1. P0가 바꾸는 파일 (anchors)

전부 `src-tauri/src/`:

- `commands/skills.rs:354-385` `scan_external_skills_core` — 단일 `~/.claude` → **roots 주입** 멀티루트.
- `commands/skills.rs:364` `if !dir.is_dir() { continue; }` → **`is_dir() || is_symlink()`** 로 완화(심링크 스킬 dir 미드롭).
- `commands/skills.rs:420-435` `ensure_within_skills_dir` — 하드코딩 `claude_skills_dir()` → **ROOTS 중 하나** starts_with (`..` 거부·`SKILL.md` basename 유지).
- `commands/skills.rs:303-306` `claude_skills_dir()` — ROOTS 해석의 일부로 흡수(또는 유지하고 ROOTS가 참조).
- `commands/skills.rs:155-186` `list_skills` 합성부 — 외부 행에 **`provider`** 세팅.
- `models/skills.rs:14` `Skill` — `provider: SkillProvider` 필드 추가(**프런트 계약**).
- `models/skills.rs:43` `ExternalSkill` — `provider` 추가(내부).
- `models/project.rs:66` `Provider{Github,Local}` — **충돌 금지**. 새 타입은 반드시 `SkillProvider`.
- `src/components/SkillsView.tsx:209` `providerOf` — **P0 아님**(P1에서 삭제). P0는 `Skill.provider` 필드만 공급.

## 2. 구현 순서 (한 PR = P0)

1. **`SkillProvider` enum** 정의(`models/skills.rs` 또는 적절 위치):
   ```rust
   #[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
   #[serde(rename_all = "lowercase")]
   pub enum SkillProvider { Claude, Codex, Openclaw, Hermes, Other }
   ```
   (specta가 TS union `"claude"|"codex"|...` 방출 → 프런트 `providerOf` 리터럴 대체.)
2. **단일 ROOTS 테이블** — 스캔·가드 공유:
   ```
   (Claude,   ~/.claude/skills,   recursive=false)
   (Codex,    ~/.codex/skills,    false)
   (Codex,    ~/.agents/skills,   false)   // ⚑ P1에서 Copilot 귀속 재검토
   (Openclaw, ~/.openclaw/skills, false)
   ```
   Hermes 제외(경로 미확인). `recursive`는 컬럼만, 전부 false.
3. **`scan_external_skills_core(roots: &[(SkillProvider, PathBuf, bool)]) -> Vec<ExternalSkill>`** 로 리팩터.
   `#[command]` 래퍼가 실제 $HOME ROOTS 해석 후 호출(**테스트는 tempdir roots 주입 → hermetic**).
   - frontmatter-only 유지. **해싱 금지**(`sha2`/`walkdir`/`hash_directory` 도입 금지).
   - per-root **skip-and-continue**(부재/읽기불가 루트 스킵, 나머지 반환, 무에러).
   - `is_dir() || is_symlink()` 수용. 각 루트 provider 태깅.
4. **path-guard 일반화**(C1, critical): `(.. 없음) AND (basename==SKILL.md) AND (ROOTS 중 starts_with)`.
5. **`list_skills`**가 외부 행에 provider 실어 반환(`Skill.provider`).
6. **bindings 재생성**: `cargo test`가 `src/bindings.ts` 생성(lib.rs export_bindings 테스트). 재생성본 커밋.
   (P0는 새 `#[tauri::command]` 없음 → `lib.rs:42 collect_commands![]` 변경 불요. `SkillProvider`는 `Skill`
   반환 경유 자동 export.)

## 3. 테스트 (hermetic — Done-criteria)

`commands/skills.rs` 테스트 모듈에 tempdir 기반으로(현 테스트는 실 `~/.claude` 의존 → 교체):

- 루트별 provider 분류 / 부재 graceful / **부분실패**(읽기가능+불가 → 가능분 반환·무에러) /
  심링크 스킬 dir 발견 / 멀티루트 frontmatter 파싱 /
- **path-guard 루트별**: in-root 허용 · `<root>/../../tmp/SKILL.md` 거부 · 전 루트 밖 거부 · 非SKILL.md 거부.
- 통합: `list_skills` = 인앱(DB) + 멀티루트 외부 병합, 외부 행에 provider.

## 4. 검증 명령 (정본 = `docs/reference/commands.md`)

```bash
export PATH="$HOME/.cargo/bin:$PATH"   # cargo가 기본 PATH에 없음(husky pre-commit도 cargo fmt 실행)
cargo test  --manifest-path src-tauri/Cargo.toml                         # + bindings.ts 재생성
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt   --manifest-path src-tauri/Cargo.toml --check
pnpm typecheck && pnpm lint
git diff --exit-code src/bindings.ts                                     # drift 0 (CI 게이트)
# grep 게이트: P0 diff에 hash_directory/sha2/content_hash 부재 · 스캔 로그에 경로/frontmatter 부재
```

> 도구 주의: rtk-wrapped cargo 출력 부정확 → 의심 시 `rtk proxy cargo`로 재확인(`docs/areas/shell-tooling.md`).

## 5. 결정/플래그 (구현 중 지킬 것)

- **no-PII 로깅**: 스캔 로그는 count + provider만. 절대 경로/frontmatter 본문 금지(AGENTS.md).
- **`.agents/skills` = Codex 태깅**(P0). Copilot 추가 시 공유 → **P1 재검토 플래그**(landing 시 `decisions.md`에 한 줄 breadcrumb 권장).
- **DEFER 확인**: `detect_skill_environments`=P1 · 재귀+Hermes=후속 · dedup=P5. P0는 중복 행 표시 가능(P5 전).
- **레일**: 읽기 전용·비실행·외부 dir 무쓰기(P0는 viewer 절반, ADR-0006 매니저 경로 아님).

## 6. 마무리 (P0 완료 시)

- done-criteria 전부 green 확인 → **critic/verifier 별도 패스**(self-approve 금지, INVARIANT 무위반 확인).
- `docs/decisions.md`에 P0 결정 한 줄(+`.agents/skills` Copilot 귀속 P1 재검토 breadcrumb).
- **push는 `dev`만**(main PR-only, husky pre-push가 main 차단). 커밋 전 `export PATH` 잊지 말 것.
- 다음: P1(env 사이드바 + detect_skill_environments 신설).

## 부록 — ralplan 컨센서스 기록 (P0)

- Planner→Architect→Critic, **2 iterations → APPROVE**(2026-05-30).
- iter1 Critic ITERATE C1–C8 → 전부 반영 → iter2 APPROVE(principle-option PASS, nit 2건 비차단).
- C1(critical) path-guard split-brain, C2 provider on `Skill`(not `ExternalSkill`), C3 no-hashing,
  C4 detect→P1, C5 재귀 cut, C6 roots 단일출처+hermetic, C7 no-PII 로깅, C8 머신카운트 강등.
