# Skills Manager G1 (Foundation) — Design Spec

> 작성 2026-05-31. 스코프: ADR-0006 풀 매니저의 **G1 foundation** 라운드.
> 정본 플랜: `docs/plans/2026-05-29-skills-manager-migration.md` Phase G1.
> 정본 결정: `docs/adr/0006-skills-registry-full-manager.md`.

## 0. 배경 / 전제

- ADR-0006(accepted 2026-05-30)이 스킬 레지스트리를 **뷰어 → 풀 매니저**로 확장했다.
  레일 4개: ①외부 dir 쓰기는 사용자 발동·가역·감사 ②중앙 라이브러리 = managed 스킬 SSOT
  ③네트워크 설치는 Rust+keychain+bounded retry ④auto-update는 opt-in·fetch까지만.
- **선행 INVARIANT 개정은 이미 완료** — `f752815`가 `decision-rails.md`(#2/#7) + `AGENTS.md`를
  ADR-0006 경계로 개정했다. **별도 prerequisite PR 불필요.** (핸드오프의 "선행 follow-up"은 stale.)
- P0~P5(뷰어 절반)은 dev 머지 완료(HEAD `bb68542`). G1은 P0(스캔)·P1(네비) 위에 선다.

## 1. 스코프 결정 (이 라운드)

**Foundation-first.** G1 = **audit_log + 중앙 라이브러리 + import round-trip** 만.

명시적 deferred → **G1.5** (별도 라운드):

- 네트워크 설치(skills.sh #20 / git #21) — keychain + bounded retry 표면
- git 백업/복구(#23)
- auto-updater(#24)

이 라운드는 **네트워크 0 · 외부 dir 쓰기 0**. 레일 ③④와 G2의 외부-dir-apply(레일 ①)는
건드리지 않는다. 중앙 라이브러리(레일 ②)와 그 import/가역만 다룬다.

## 2. 아키텍처 / 모듈 레이아웃

현재 스킬 백엔드는 **단일 `commands/skills.rs`(~89KB)** + `models/skills.rs`에 몰려 있다.
G1은 여기에 중앙레포·import·audit를 더하므로, 먼저 **무변경 리팩터**로 모듈 dir을 만든다.

리팩터 후 목표 구조:

```
src-tauri/src/skills/            (was: commands/skills.rs)
  mod.rs          — re-export + #[tauri::command] 표면 wiring
  model.rs        — Skill / ExternalSkill / SkillProvider / … (models/skills.rs 이동)
  seed.rs         — seed_in_app_skills, resolve_prompt
  scan.rs         — env detection, user roots, 재귀 외부 스캔
  tags.rs         — set/list skill_tags
  registry.rs     — list_skills / create / update / delete (통합-id 합성)
  ─── G1 신설 ───
  central_repo.rs — managed 스토어: app_data_dir/skills-library/
  import.rs       — discovered 외부 → 중앙 복사 (round-trip + 가역)
  audit_log.rs    — managed 스토어 모든 쓰기에 audit 행 append
```

ADR-0006 §More Information의 이식 대상 이름(`core/central_repo`, `core/audit_log`,
`core/installer`…)과 1:1로 정렬된다. 모듈 경계 기준: 각 파일은 한 책임, 잘 정의된 함수
표면으로만 소통, 단독 테스트 가능.

## 3. PR 분해 (3개, 한 PR=한 관심사)

### G1-PR1 — 순수 리팩터 (무행동변경)

- `commands/skills.rs` → `src-tauri/src/skills/` 모듈 dir로 분할. `models/skills.rs`도 `skills/model.rs`로.
- **새 커맨드 0 · 마이그레이션 0 · IPC 변경 0.**
- 게이트: `cargo test` + clippy + fmt + **bindings drift 0**(= IPC 무변경 증명) + 프런트.

### G1-PR2 — audit_log

- 마이그레이션 `0039_skill_audit_log.sql`: append-only 테이블.
  컬럼(안): `id`, `action`(import/remove/…), `target_kind`(managed_skill/…),
  `target_ref`(중앙 경로 등), `source_ref`(원본 외부 경로, nullable), `detail`(크기 등 비밀-free), `created_at`.
- `audit_log.rs`: 내부 `audit(...)` 헬퍼 + 읽기 커맨드 `list_skill_audit`(UI용).
- **로그 시크릿 금지**: frontmatter 본문·토큰 미기록. 경로 + action + 크기만.
- 게이트: cargo + bindings 재생성 + 프런트.

### G1-PR3 — 중앙 라이브러리 + import round-trip

- `central_repo.rs`: 스토어 위치 = `app_data_dir()/skills-library/<provider>/<name>/`.
  (app_data_dir는 `lib.rs:333`에서 이미 resolve — DB와 동일 베이스.)
- `import.rs`:
  - `import_external_skill(path)` — discovered 외부 스킬의 `SKILL.md` + 파일들을 중앙으로 복사.
    복사 시점부터 중앙이 SSOT. 모든 쓰기는 `audit(action=import, …)` 경유.
  - `remove_managed_skill(id)` — 중앙 복사본만 삭제(가역). **원본 외부 파일 절대 무변경.**
    `audit(action=remove, …)`. → import가 G1 안에서 가역 완결.
- `registry.rs` `list_skills` 확장: import된 스킬은 **managed**로 표시하고, 매칭되는 discovered
  엔트리는 **목록에서 suppress**.
  - **identity = name + provider**, P5의 `src/lib/skillDedup.ts` `groupCrossToolSkills` 식별 로직 재사용.
  - 카드에 provenance 노트("imported from ~/.claude/…").
- SkillsView: managed 배지 + import 액션. Sheet 건드리면 **Esc 스모크** 필수.
- 게이트: cargo + bindings + 프런트 + (Sheet 변경 시) Esc 스모크.

## 4. 데이터 흐름 — import

```
discovered ExternalSkill (디스크 SSOT, 읽기전용)
   │  사용자 "라이브러리로 import" 클릭
   ▼
import_external_skill(path)
   ├─ SKILL.md + 파일 → app_data_dir/skills-library/<provider>/<name>/ 복사
   ├─ audit(action=import, target=<중앙 경로>, source=<외부 경로>)
   └─ managed Skill 반환
   ▼
list_skills → managed 카드 노출; discovered 중복은 (name+provider) suppress
   │  사용자 "라이브러리에서 제거"
   ▼
remove_managed_skill(id) → 중앙 복사본만 삭제 + audit(remove); 외부 파일 무변경
```

## 5. 에러 / 레일

- 신규 커맨드 전부 `Result<_, AppError>`(단일 envelope, 기존 `From` 재사용).
- **가역(레일 ①)**: import의 역연산(remove_managed_skill)을 G1에 포함 — 외부-dir-apply는 G2지만
  중앙레포 import 자체의 가역성은 G1에서 완결.
- **audit(가역·감사)**: 모든 managed 쓰기(import/remove)가 audit 행 1개 생성.
- **로그 시크릿 금지**: audit detail은 경로/action/크기만.
- **#1/#2 불변**: 스킬을 import해도 codex 잡은 자동 실행/적용되지 않는다 — 파일 I/O일 뿐.
- 네트워크/외부-dir 쓰기 없음 → 레일 ③④ + G2 표면 이 라운드 미접촉.

## 6. 테스트 (hermetic — Done-criteria)

- **import round-trip**: tempdir 외부 스킬 → import → 중앙 복사본 존재 + 내용 일치 →
  remove → 중앙 사라짐 + **외부 파일 무손상** assert.
- **dedup**: import 후 `list_skills`가 managed 1개 · discovered 중복 0개.
- **audit**: import/remove 각각 audit 행 정확히 1개; detail에 비밀 substring 없음 assert.
- **#1/#2 가드(유지)**: import가 잡 spawn/실행 안 함 — 게이트 불변 assert.
- 게이트(정본 `docs/reference/commands.md`): cargo test/clippy/fmt + bindings drift 0 +
  pnpm typecheck/lint/vitest + (Sheet 변경 시) Esc 스모크.

## 7. Done-criteria (G1, 플랜 발췌 + 본 스펙 구체화)

- [ ] import round-trip(외부→중앙→복원) — hermetic 테스트 green.
- [ ] managed가 discovered를 suppress(중복 카드 0) — 테스트 + 수동 확인.
- [ ] 모든 managed 쓰기 audit 기록 — 테스트.
- [ ] auto-update/잡 자동실행 부재(#1/#2 가드 유지) — 테스트.
- [ ] 3 PR 전부 게이트 green + bindings drift 0, dev push, plain-git ls-remote MATCH.

## 8. Deferred (G1.5+ / 비차단)

- 네트워크 설치(skills.sh/git), git 백업/복구, auto-updater → **G1.5**.
- 외부 dir 적용(심링크/복사) + 프리셋 → **G2**(레일 ①).
- 프로젝트 워크스페이스 + 양방향 sync + sync 헬스 배지 → **G3**.

## 9. 미해결 / 가정

- audit_log = SQLite 테이블(append-only file 아님) — local-DB-SSOT 일관성 위해 채택.
- 중앙 스토어 디렉터리 레이아웃 `<provider>/<name>/`은 G1.5의 git 백업 단위로도 자연스럽다(가정).
