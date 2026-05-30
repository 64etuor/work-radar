# 스킬 레지스트리 — skills-manager UX 이식 (phase 단위)

작성 2026-05-29. 개정 2026-05-30(A–F 기능 선택 반영, PR 단위 → Phase 단위 재구성).
브랜치 `feat/skills-mgr-migration` (worktree). 기준 `dev`.

## 배경

현 `SkillsView`(스킬 레지스트리, Phase 20 #21)는 2-pane(좌 세그먼트 리스트 + 우 편집
패널)에 raw `<pre>` 뷰어로, UX가 빈약하고 **`~/.claude`만 스캔**한다(Codex 34개·Hermes
스킬을 통째로 못 본다). 오픈소스 [skills-manager](https://github.com/xingkongliang/skills-manager)
(Tauri+React 스킬 관리 GUI)의 기능을 골라 단계별로 차용한다.

**디자인 컨셉은 work-radar(Cohere white editorial, Tailwind v4 `@theme` `--color-wr-*`,
shadcn) 유지.** skills-manager의 클래스/토큰은 work-radar 토큰으로 매핑한다.

## 차용 원칙 / 레일

work-radar의 데이터 모델·커맨드·INVARIANT는 **그대로 둔다**. skills-manager의 *기능/표현*만 가져온다.

**불변 (전 Phase — A–F·G 공통):**

- 외부 스킬 파일은 **실행하지 않는다**(#1/#2). 스킬/인앱 프롬프트는 codex 잡을 **자동 실행/적용하지
  않는다** — 잡은 여전히 gated + Acceptance. 스킬 _파일_ 관리(설치/sync) ≠ 잡 실행.
- 인앱 프롬프트 편집은 codex **제안 내용**만 바꾼다. 자동적용 경로 없음.
- 외부 네트워크는 Rust + keychain + bounded retry. 로그에 시크릿/PII 금지.

**Phase A–F 한정 (G에서 ADR-0006으로 개정):**

- 외부 스킬(`~/.{claude,codex,openclaw}/skills/*/SKILL.md`)은 **디스크 SSOT, 읽기/편집 전용**, 외부
  dir **무쓰기**. 스캔은 **frontmatter-only(전체 콘텐츠 해싱 도입 금지 — skills-manager 느림 원인)**.
- `Skill`에 `project_id` 없음(#7) — project vs global은 **표시 순서/그룹**일 뿐.

**Phase G (ADR-0006 — `docs/adr/0006-skills-registry-full-manager.md`):** 중앙 라이브러리 SSOT,
외부 dir 쓰기/설치/sync(사용자 발동·가역·audit), 네트워크 설치, opt-in·bounded auto-update를 도입.
위 "불변"은 G에서도 유지.

## 기능 선택 (A–F 전부) → Phase 매핑

사용자 선택: A–F 전부 차용. INVARIANT 충돌 항목은 **ADR-0006(풀 매니저 채택)**으로 레일을 재설정해
Phase G1–G3에서 구현한다. 표식: ✅ 레일 안전 · ⚠️ 각색 필요 · 🟢 ADR-0006으로 채택(레일 재설정) · 📌 PR1 완료.

| #   | 기능                                        | 표식 | Phase    |
| --- | ------------------------------------------- | ---- | -------- |
| 1   | 멀티루트 스캔(claude/codex/openclaw/agents) | 📌   | P0(평면) |
| 1b  | Hermes 루트 + env-aware 위치 resolution     | ⚠️   | P1·P1.5  |
| 1c  | 사용자 설정 임의 루트 + 레포-로컬 루트      | ⚠️   | P1.5     |
| 3   | 재귀 스캔(중첩 카테고리)                    | ⚠️   | P1.5     |
| 2   | 환경 감지 사이드바 + All 집계 + 카운트      | ✅   | P1       |
| 14  | 사이드바 드래그 재정렬(로컬 순서)           | ✅   | P1       |
| 5   | 카드 그리드 ↔ 리스트 토글                   | 📌   | P2       |
| 6   | 슬라이드오버 Sheet 상세                     | 📌   | P2       |
| 7   | SKILL.md 마크다운 렌더                      | ✅   | P2       |
| 8   | 커맨드 팔레트 → 스킬 점프                   | ✅   | P2       |
| 11  | 도움말 다이얼로그(Help)                     | ✅   | P2       |
| 12  | 태그 + 태그 필터 (유일 스키마 변경)         | ✅   | P3       |
| 9   | 다중 선택 툴바 + 배치(인앱 한정)            | ⚠️   | P3       |
| 10  | 상태 인디케이터(work-radar 의미로 재정의)   | ⚠️   | P3       |
| 18  | Diff 뷰어(인앱 커스터마이즈 vs 폴백)        | ✅   | P4       |
| 19  | 외부 파일 편집(이미 존재 — Sheet 통합)      | ✅   | P4       |
| 4   | 콘텐츠 지문 dedup(도구 간 동일 스킬 그룹화) | ⚠️   | P5       |
| 20  | skills.sh 마켓플레이스 설치(네트워크)       | 🟢   | G1       |
| 21  | git 레포에서 스킬 설치                      | 🟢   | G1       |
| 23  | git 백업 / 복구                             | 🟢   | G1       |
| 24  | 스킬 auto-updater(백그라운드 git pull)      | 🟢   | G1       |
| 13  | 프리셋 = 에이전트 dir에 설치/심링크         | 🟢   | G2       |
| 15  | 에이전트별 enable/disable = 심링크 토글     | 🟢   | G2       |
| 16  | 프로젝트 워크스페이스 추가/보기             | 🟢   | G3       |
| 17  | 프로젝트 sync 헬스 배지                     | 🟢   | G3       |
| 22  | 양방향 sync 엔진(프로젝트↔중앙레포)         | 🟢   | G3       |

> G(13·15·16·17·20–24)는 skills-manager의 **"패키지 매니저" 절반**이다. **ADR-0006(풀 매니저 채택,
> accepted 2026-05-30)**으로 레일을 재설정해 구현한다 — 외부 dir 쓰기는 사용자 발동·가역·감사,
> 네트워크/업데이트는 Rust+keychain+bounded, 그리고 **잡 자동실행 금지(#1/#2)는 유지**. 상세: `docs/adr/0006-skills-registry-full-manager.md`.

---

## Phase 0 — 백엔드 스캔 토대 (✅ rail-safe, 선행)

**의존**: 없음. 이후 전 Phase의 토대.

> **상태: ralplan 컨센서스 APPROVE (2026-05-30, 2 iterations · Planner→Architect→Critic).** 아래는
> 합의된 스펙. 실행 승인 대기(`pending approval`).

### 루트 단일 진실원 (C6)

스캔·path-guard(·후속 P1 detect)가 **공유하는 단 하나의 정의**:
`ROOTS: &[(SkillProvider, PathBuf, recursive: bool)]` =

- `(Claude, ~/.claude/skills, false)`
- `(Codex, ~/.codex/skills, false)`
- `(Codex, ~/.agents/skills, false)` — 공유 발견 dir, P0에선 **Codex로 태깅**(upstream codex 귀속
  `tool_adapters.rs:189`). ⚑ Copilot 추가 시 `.agents/skills`는 공유 → **P1에서 귀속 재검토**.
- `(Openclaw, ~/.openclaw/skills, false)`
  **Hermes는 P0에서 의도적 제외**(경로 미확인). `recursive`는 컬럼만 두고 P0 전부 false.

### Deliverables

1. **Provider 타입**: 신규 `enum SkillProvider { Claude, Codex, Openclaw, Hermes, Other }`
   (`#[derive(Type,Serialize,Deserialize)]` + `rename_all="lowercase"` → TS union). **기존 `Provider{Github,Local}`
   (project.rs:66)와 별개 — 이름 충돌 금지**(C2). `provider`를 `list_skills`가 합성하는 **`Skill`** 구조체에
   탑재(프런트 계약 = `Skill.provider`; `ExternalSkill`도 내부적으로 보유 가능).
2. **멀티루트 스캔**: `scan_external_skills_core(roots: &[(SkillProvider, PathBuf, bool)]) -> Vec<ExternalSkill>`로
   리팩터(roots **주입** → hermetic 테스트). `#[command]` 래퍼가 실제 $HOME ROOTS를 해석해 호출. 각 루트
   frontmatter-only(**해싱 금지 — sha2/walkdir/hash_directory P0 진입 금지**), `is_dir() || is_symlink()` 수용
   (심링크 스킬 dir 미드롭), 루트의 provider로 태깅.
3. **부분실패 정책 (C6)**: per-root skip-and-continue — 읽기 불가/부재 루트는 스킵, 나머지 루트 스킬 반환,
   전체 스캔 에러 없음.
4. **path-guard 확장 (C1 — critical)**: `ensure_within_skills_dir`를 일반화 — `(.. 컴포넌트 없음) AND
(basename==SKILL.md) AND (ROOTS 중 하나로 starts_with)`. 단일 `claude_skills_dir()` 하드코딩 대체. 스캔과
   가드는 **동일 ROOTS** 소비.
5. **no-PII 로깅 (C7)**: 스캔 로그는 count + provider만 — 절대 경로/frontmatter 본문 금지. grep 가능.
6. **`bindings.ts` 재생성**(SkillProvider union + Skill.provider). drift = 0 CI 게이트.

### P0에서 명시적으로 DEFER

- `detect_skill_environments` → **P1**(P0 소비자 없음; 동일 ROOTS + provider 태깅 list_skills에서 도출). (C4)
- 재귀 발견 + Hermes 루트 → **P1.5로 이관**. (위 표의 "#3 재귀=P0"는 구현에서 deferred됨 — **표↔구현 불일치 정정**.) 재귀 코드 P0 미반입(데드코드 금지). (C5)
  - **2026-05-30 실측 발견**: Hermes 경로 = **`~/.hermes/skills`(확정·존재)** — P0의 "경로 미확인"은 해소됨. Hermes는 대부분 **카테고리 중첩**(`<root>/<cat>/<skill>/SKILL.md`)이라 재귀 101개 중 평면은 2개뿐. **비재귀 누락은 Hermes만이 아니다**: 이미 스캔 중인 `~/.claude/skills`도 평면 70 + **중첩 53 누락**. 따라서 P1.5에서 재귀 필수(아래 Phase 1.5).
- 도구 간 dedup → **P5**. P0는 동일 스킬을 두 루트에서 별도 provider 행으로 표시 가능(P5 전까지 허용).

### Done-criteria — hermetic CI + 수동 스모크

- **Hermetic 단위테스트(tempdir, 실제 ~/.claude 비의존)**: ①루트별 provider 분류 ②부재 graceful
  ③부분실패(읽기가능+불가 → 가능분 반환·무에러) ④심링크 스킬 dir 발견 ⑤멀티루트 frontmatter 파싱
  ⑥path-guard 루트별(in-root 허용 / `<root>/../../tmp/SKILL.md` 거부 / 전 루트 밖 거부 / 非SKILL.md 거부).
- **통합**: `list_skills`가 인앱(DB)+멀티루트 외부 병합, 각 외부 행에 provider.
- **수동 스모크(CI 게이트 아님, C8)**: 이 머신에서 codex provider="codex" 약 34개, claude 약 71개.
- **게이트**: `cargo test` green · `clippy --all-targets -D warnings` · `fmt --check` ·
  `git diff --exit-code src/bindings.ts` · `pnpm typecheck` · grep(P0 diff에 `hash_directory`/`sha2`/
  `content_hash` 부재 · 스캔 로그에 경로/frontmatter 부재).

## Phase 1 — 환경 감지 사이드바 (✅ rail-safe)

**의존**: P0.

### Deliverables

- **`detect_skill_environments` 커맨드**(P0에서 이관 — C4): 환경별 `{provider, present, skill_count, root_path}`
  반환. 사이드바가 유일 소비자라 여기서 신설. **위치 문제 해결(위치 ≠ 깊이)**: 루트를 상수로 가정하지 말고
  **env-aware resolution**으로 찾는다 — `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`XDG_CONFIG_HOME`(→`~/.config/<tool>/skills`)
  등을 먼저 보고 표준 dotfile(`~/.<tool>/skills`)은 **폴백**. (P0의 하드코딩 ROOTS → resolve 함수로 강등; C6 단일
  출처 유지 — `skill_roots()`가 정적 상수 → resolve 결과를 돌려주게 진화.)
- SkillsView에 **좌측 env 사이드바**(#2): skills-manager `Sidebar.tsx`의 그룹 구조 차용 →
  **"All"(집계) + 감지된 환경 그룹만**(detect dir 존재 시에만 렌더; OpenClaw 없으면 섹션 X).
- 환경별 **카운트 배지** = `enabled/total`(기존 `segmentSkills`의 health 재사용).
- 사이드바 선택 → 메인(P2 카드)이 그 환경으로 필터. "All" = 전 환경 집계.
- 프런트 `providerOf()` 경로추론 **제거** → P0의 백엔드 `provider` 사용.
- **드래그 재정렬**(#14): 사이드바 항목 로컬 순서(localStorage), 외부 상태 변경 없음.

### Done-criteria

- 설치된 환경만 사이드바에 노출(스모크: `~/.openclaw` 없음 → Lobster 그룹 미노출).
- Claude/Codex 카운트 정확, All 집계 = 합.
- `pnpm typecheck`/`lint`/`vitest run` green.

## Phase 1.5 — 루트 발견·깊이 완성 (⚠️ skm-초월 스캔 로직)

**의존**: P1(env-resolution·detect). **목표**: "보이는 스킬 = 실제 디스크 스킬"이 되도록 **위치(어디)**와
**깊이(얼마나 깊이)** 두 축을 모두 닫는다. 동기 = 사용자가 Hermes·중첩 스킬 누락을 발견(2026-05-30).

### 문제 두 축 (재귀만으로 안 풀린다)

| 축                  | 증상                                         | 해법                                                    |
| ------------------- | -------------------------------------------- | ------------------------------------------------------- |
| **깊이**(루트 안)   | 중첩 카테고리 스킬 누락(claude 53·hermes 99) | **바운디드 재귀**                                       |
| **위치**(루트 자체) | 루트 경로가 우리 상수와 다르면 트리째 안 봄  | **루트 resolution + 사용자/레포 루트** ← 재귀로 안 풀림 |

### skills-manager(skm) 대비 — "더 나은 로직"의 정의

skm은 (a) 매 스캔 **전 파일 SHA256 + 싱글스레드 + 무캐시**라 느리고, (b) 자체 중앙 스토어
`~/.skills-manager/skills`(이 머신 680개)로 **복사-집계**해야 "다 보인다"(디스크 중복·sync 부담). 우리는:

| 항목           | skm                         | work-radar(목표)                                                 |
| -------------- | --------------------------- | ---------------------------------------------------------------- |
| 발견 메타      | 전 콘텐츠 SHA256            | **frontmatter-only**(해싱 금지, C3) — 재귀해도 저렴              |
| "다 보임" 방식 | 중앙 스토어로 **복사-집계** | **in-place 스캔**(디스크=SSOT, 복사 불요; 중앙화는 G에서 opt-in) |
| 위치           | (가정/스토어)               | **env-aware resolution + 사용자 설정 루트 + 레포 루트**          |
| 깊이           | naive 재귀                  | **바운디드 재귀**(depth cap·ignore·심링크 사이클 가드)           |
| 레포 스캔 안전 | node_modules 등 무방비      | **ignore 리스트 + depth bound**로 거대 트리 방어                 |
| 중복           | (스토어가 단일화)           | P5 lazy dedup(`path,mtime,size` 캐시 — eager 해시 안 함)         |

### Deliverables

1. **루트 resolution 합성(C6 단일 출처 유지)**: `skill_roots()`를 정적 상수 → **`[env-resolved 도구 루트] +
[사용자 설정 루트] + [레포 local_path 루트]`** 합성으로. 각 루트 메타 = `(provider, root, recursive, ignore, max_depth)`.
   - **env-resolution**: 도구별 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`XDG_CONFIG_HOME` 우선 → 표준 dotfile 폴백.
   - **Hermes 루트 추가**: `~/.hermes/skills`(`SkillProvider::Hermes` — enum에 이미 존재), `recursive=true`.
2. **바운디드 재귀**(`recursive=true` 처리 — 현재 컬럼만 존재):
   - **리프 규칙**: SKILL.md를 가진 dir = 스킬, 거기서 하강 중단(이중 카운트·무한 하강 방지).
   - **max_depth 바운드**(글로벌 카테고리엔 2 충분; per-root 설정), **ignore 리스트**(`.git`/`node_modules`/
     `target`/`dist`/`vendor`/숨김 dir) — **특히 레포 루트에서 필수**.
   - **심링크**: 재귀 하강 중엔 안 따라감(P0처럼 최상위 심링크 dir만 수용) + 방문 셋 사이클 가드.
3. **사용자 설정 임의 루트**: Settings에서 임의 스킬 dir 추가(우리가 모르는 위치의 최종 안전망). 이게
   "설정의 레포" 요청과 한 메커니즘으로 합쳐짐. 영속(app_config/DB), provider=`Other`(또는 사용자 라벨).
4. **레포-로컬 루트**(설정의 프로젝트/로컬 레포): `repos.local_path`가 있는 레포의 스킬 dir를 ROOTS에 동적
   추가 — **레포 내 에이전트 dir 규칙**(`<repo>/.claude/skills`·`.codex/skills`·`.agents/skills`, 글로벌과 동일
   규칙을 레포 루트로). `Provider::Github`(remote_url만, 로컬 체크아웃 없음)은 대상 아님. 재귀+ignore 필수.
5. **path-guard 동일 합성 ROOTS 소비**(C1 유지): resolve된 전 루트(도구+사용자+레포)에 대해 starts_with 검사.
6. **no-`~/.skills-manager/skills`**: skm 자체 스토어는 ROOTS 제외(대량 중복 방지).

### Done-criteria

- **위치**: env override(`CODEX_HOME` 등) 적용 시 그 경로 스캔 / 미설정 시 dotfile 폴백 — hermetic 테스트
  (tempdir + env 주입). 사용자 설정 루트·레포 루트 추가분이 결과에 병합.
- **깊이**: 중첩 fixture(`<root>/<cat>/<skill>/SKILL.md`)가 재귀로 발견 / ignore dir(`node_modules`) 스킵 /
  max_depth 초과 미하강 / 심링크 사이클 무한루프 없음 — 전부 hermetic.
- **회귀**: 이 머신 스모크 — Hermes 표면(평면 2 → 재귀 ~101), claude 평면 70 → 70+중첩(누락 53 회복) 확인.
- **레일**: 읽기 전용·외부 dir 무쓰기 유지. no-PII 로그(provider+count+root는 OK, frontmatter 본문·전 경로 금지).
- 게이트: `cargo test`·clippy·fmt·bindings drift 0·프런트. **해싱 부재(C3) grep 유지**.

## Phase 2 — 표현 (📌 PR1 일부 완료 + ✅ 추가)

**의존**: P1. **PR1(카드 그리드/리스트 + Sheet, #5·#6)은 완료**(@9161f1d, 아래 부록). 나머지 추가.

### Deliverables

- **마크다운 렌더**(#7): 외부 `SKILL.md`를 Sheet에서 렌더(현재 raw `<pre>`). 렌더러 의존성 결정 필요
  (경량 우선). 읽기 전용 표시 — 편집 모드는 P4의 textarea 유지.
- **커맨드 팔레트 점프**(#8): 기존 `pendingSkillId`(store) 경로 확장 — 팔레트에서 스킬명 검색 →
  해당 스킬 선택/Sheet open. 자동 실행 없음(#1).
- **도움말 다이얼로그**(#11): 단축키/스킬 모델 설명. overlay-stack 마커 준수.

### Done-criteria

- 외부 SKILL.md가 마크다운으로 렌더(코드블록/리스트/링크 확인).
- 팔레트 → 스킬 점프 동작, Esc 계약(아래 부록) 유지.
- Esc 스모크(cmux/Playwright) 통과 — 창 hide 미호출.

## Phase 3 — 정리 / 분류 (✅ 태그 + ⚠️ 배치/상태)

**의존**: P2. **유일한 스키마 변경 Phase.**

### Deliverables

- **태그 + 필터**(#12): `skill_tags` 매핑(인앱=skill id, 외부=source_path) 마이그레이션 + set/list
  커맨드 + `bindings.ts` 재생성. 태그 필터 pill + Untagged. (data-layer-conventions 준수.)
- **다중 선택 툴바**(#9, ⚠️): 여러 스킬 선택 → 배치 토글/태그/삭제. **외부 스킬은 읽기 전용이라 배치
  대상에서 제외**(인앱 프롬프트 한정). 외부는 선택 시 태그만 허용(파일 무변경).
- **상태 인디케이터**(#10, ⚠️): skills-manager의 sync 점(diverged/in-sync)은 **도입 안 함**(work-radar엔
  sync 모델 없음). work-radar 의미로 재정의: `enabled/off` · `kind`(인앱/외부) · `provider` 배지만.

### Done-criteria

- 태그 set/list + 필터 동작, 마이그레이션 idempotent, bindings drift 0.
- 배치 작업이 인앱에만 적용(외부 파일 무변경 — 테스트로 가드).
- `cargo test` + 프런트 게이트 green.

## Phase 4 — 편집 / Diff (✅ rail-safe, 각색)

**의존**: P2.

### Deliverables

- **Diff 뷰어**(#18): 커스터마이즈된 인앱 프롬프트를 **코드 상수 폴백과 diff** + **reset-to-default**.
  skills-manager의 sync-diff UX를 work-radar 폴백 모델(`fallback_prompt`)에 접지. 외부 스킬엔 미적용.
- **외부 파일 편집 통합**(#19): 이미 존재(`write_external_skill`, 경로 가드). Sheet UI에 자연스럽게 통합.

### Done-criteria

- 편집된 인앱 프롬프트의 diff 표시 + 기본 복원 동작(복원 = prompt를 코드 상수로).
- 외부 편집 경로 가드(`ensure_within_skills_dir`) 유지 — 다중 루트로 확장 시에도 탈출 차단.

## Phase 5 — 콘텐츠 dedup (⚠️ 각색 필수)

**의존**: P0.

### Deliverables

- **도구 간 동일 스킬 그룹화**(#4): claude·codex에 같은 스킬이 있으면 한 카드로 묶고 "위치 N곳" 표시
  (skills-manager `group_discovered` 개념).
- **단, eager 전체-콘텐츠 해싱 금지**(skills-manager 느림 원인). 대안:
  `(path, mtime, size)` 캐시로 변경분만 재해싱하거나, 지문을 **lazy/백그라운드**로 계산(목록은 즉시).
  지문 자체도 전체 내용 대신 `SKILL.md` + 파일목록 + mtime으로 경량화 검토.

### Done-criteria

- claude/codex의 동일 스킬이 하나로 그룹화 + 출처 표시.
- 스캔 latency 회귀 **없음**(캐시 hit 시 재해싱 안 함) — before/after 측정 기록.

## Phase G — 풀 매니저 (🟢 ADR-0006 accepted 2026-05-30)

> 더 이상 게이트가 아니다. **ADR-0006**(`docs/adr/0006-skills-registry-full-manager.md`)이 레일을
> 재설정해 채택했다. 전 Phase 공통 레일(잡 자동실행 금지 #1/#2 · keychain · 로그 시크릿 금지)은 유지하고,
> 외부 dir 쓰기/네트워크/업데이트는 ADR-0006의 4개 레일(사용자 발동·가역·감사 / Rust+keychain+bounded /
> opt-in·무한poll 금지 / 자동실행 금지) 안에서만 구현한다. **선행 follow-up: `decision-rails.md` ·
> `AGENTS.md` INVARIANT 문구를 ADR-0006에 맞춰 개정**(별도 PR, reviewer 패스).

**의존**: P0(스캔)·P1(네비). 중앙 라이브러리가 토대라 G1 → G2 → G3 순.

### Phase G1 — 중앙 라이브러리 + 네트워크 설치/백업/업데이트

- **중앙 라이브러리**(skills-manager `core/central_repo` 대응): work-radar 소유 managed 스킬 스토어.
  import(발견 외부 스킬 → 중앙레포 복사, 그 시점부터 중앙이 SSOT). (ADR-0006 레일 2)
- **네트워크 설치**(#20 skills.sh / #21 git, `installer`·`git_fetcher`·`skillssh_api`): Rust 경유 +
  keychain + bounded retry(backoff+jitter+terminal failure). 토큰 렌더러 비노출. (레일 3)
- **git 백업/복구**(#23, `git_backup`): 중앙 라이브러리 백업. 가역.
- **auto-updater**(#24, `skill_auto_updater`): opt-in + bounded + **fetch까지만, 자동 적용/실행 없음**. (레일 4)
- **audit_log** 도입: 모든 외부 쓰기/네트워크/sync 기록.

**Done**: import round-trip(외부→중앙→복원); 네트워크 설치 bounded(무한 retry 없음 — 테스트);
auto-update가 잡/스킬 자동실행 안 함(#1/#2 가드 테스트 유지); 모든 쓰기 audit 기록.

### Phase G2 — 외부 dir 적용 (설치/심링크) + 프리셋

- **외부 dir 쓰기**(#15 에이전트별 enable/disable = 심링크/복사, `tool_adapters` 설치 경로):
  중앙 managed 스킬을 `~/.{claude,codex,openclaw}/skills`에 적용. **사용자 발동 · 가역(uninstall=원상복구,
  사용자 파일 무손상) · audit 기록**. config/secret 파일 비대상. (레일 1)
- **프리셋**(#13, `presets`): 스킬 번들을 환경에 일괄 적용/해제. 적용도 위 레일 1 하.

**Done**: install→uninstall이 외부 dir 원상복구(심링크 제거, 사용자 SKILL.md 무손상 — 테스트);
모든 적용/해제 audit 기록; 잡 자동실행 불변(#1/#2).

### Phase G3 — 프로젝트 워크스페이스 + 양방향 sync

- **프로젝트 워크스페이스**(#16, `projects`·`project_scanner`): 프로젝트별 스킬 보기/관리.
- **양방향 sync 엔진**(#22, `sync_engine`·`sync_metadata`): 중앙레포 ↔ 프로젝트/에이전트 dir.
  diverged/newer 감지. (ADR-0006으로 중앙레포 SSOT 채택했으므로 성립.)
- **sync 헬스 배지**(#17): P1 사이드바에 sync 상태 점 추가(diverged/in-sync) — 이제 의미 있음.

**Done**: 양방향 sync round-trip(중앙↔프로젝트 변경 반영); diverged 감지 정확; 충돌 시 사용자 확인
(비가역 덮어쓰기 없음); audit 기록.

---

## 진행 순서 / 의존

```
P0(스캔 토대·평면) ─ P1(env-resolution 네비) ─ P1.5(재귀+Hermes+레포/사용자 루트) ─┬─ P2(표현) ─┬─ P3
                                                                                    │            └─ P4
                                                                                    └─ P5(dedup)
P0·P1 완료 후 ── G1(중앙 라이브러리+설치/백업/업데이트) ── G2(외부 dir 적용) ── G3(프로젝트+sync)
                 (ADR-0006 accepted — decision-rails/AGENTS INVARIANT 개정 follow-up 선행)
```

> **P1.5 = 스캔 완성도(위치+깊이)**. P0는 평면·하드코딩-루트 토대였고, 사용자가 Hermes/중첩 누락을 발견해
> 추가됨(2026-05-30). skm 대비 우위 = frontmatter-only(무해싱) + in-place(무복사) + env/사용자/레포 루트
> resolution + 바운디드 재귀. 상세: 위 Phase 1.5.

한 PR = 한 관심사. Phase 내 여러 PR 가능. dev push만, main은 PR-only(git-conventions).

---

## 부록 — PR 1 상세 (완료, @9161f1d)

> Phase 2의 카드/Sheet(#5·#6)에 해당. 백엔드 무변경 표현 스왑. 아래는 당시 실측 기록(보존).

### 변경 파일

- `src/components/ui/sheet.tsx` **(신규)** — radix Dialog 기반 우측 슬라이드오버. `dialog.tsx`와
  동일하게 `data-wr-overlay-open` 정적 마커 + `Close` + `SheetTitle`. controlled(트리거 없음) 사용.
- `src/components/SkillsView.tsx` — 2-pane → 헤더+카드+Sheet. `segmentSkills`/`providerOf`/
  `InAppEditor`/`ExternalViewer`/`CreatePanel` 로직은 보존, 컨테이너만 교체.
  (※ P1에서 `providerOf`는 백엔드 provider로 대체 예정.)
- `src/components/SkillsView.css` — 사이드바/row 클래스 제거, 카드/툴바/섹션 클래스 추가.
  (※ P1에서 env 사이드바 클래스 재도입.)

### Esc 계약 (hard gate) — 실측 결과

- Sheet는 **프로그램적(controlled `open`)** — `DialogTrigger` 없음.
- **실측 발견**: radix는 document에 capture-phase Esc 리스너를 달아 close 시 Content를 즉시
  unmount → window 버블 시점엔 `data-wr-overlay-open` 마커가 이미 사라진다. SkillsView는 비-board라
  창은 안 숨고 board로 bounce했을 뿐 — 재사용 시 board에서 창 hide 위험.
- **수정**: `SheetContent`에 `onEscapeKeyDown={(e)=>e.stopPropagation()}` — radix가 시트 닫는 건
  그대로, Esc가 window까지 못 가게 막아 타이밍-독립적으로 안전.

### 검증 (실행 결과)

- `pnpm typecheck` 0 · `pnpm lint` 0 errors(2 pre-existing warning) · `pnpm vitest run` 194 pass. ✅
- **Esc 스모크(Playwright, vite :1430 + Tauri 스텁)**: 팔레트→스킬 뷰→"인앱 프롬프트 추가"로
  Sheet open(마커 present) → Escape → 시트 닫힘 + `hideCalls===[]` + 스킬 뷰 유지(bounce 없음). ✅
- INVARIANT #1/#2/#7 무위반 — critic ACCEPT-WITH-RESERVATIONS → 2건 해소. ✅
