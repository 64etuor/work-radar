# 스킬 매니저 G3 fast-follow — 0-스킬 프로젝트 vendoring + per-location divergence 귀속

작성 2026-06-02. 브랜치 `feat/wire-dangling-features`(현 dev tip). 기준 `dev`.
정본 로드맵 `docs/plans/2026-05-29-skills-manager-migration.md`의 G3(#16/#22/#17)는 전부 landed —
본 문서는 그 G3 표면의 **두 비차단 deferred 갭**을 닫는다(정본 deliverable 아님 = fast-follow).

## 배경

정본 #22(양방향 sync) 적대적 완성도 점검에서, **#7 불변(스키마/마이그레이션 0)으로 의식적으로
버린 항목**("newer 감지"·`sync_metadata`)과 **단순 deferred 갭**을 구분했다. 후자 중 #7을 건드리지
않고 닫을 수 있는 둘:

1. **0-스킬 프로젝트 vendoring** — 등록된 Local 프로젝트에 스킬이 아직 0개면 워크스페이스 목록에
   안 떠서, 그 프로젝트로 **첫 스킬을 vendor(복사)할 수 없다**(닭-달걀). 백엔드 write 경로
   (`vendor_skill_to_project`)는 이미 0-스킬 프로젝트를 지원 — 순수 **discovery/listing 갭**.
2. **per-location divergence 귀속** — 카드의 divergence 마커가 바이너리("·다름")라 **어느
   프로젝트/위치가 diverged인지** 표시하지 않는다. 데이터(`SkillDivergence`)는 이미 location별
   (`memberPath`+`repoId`)로 내려옴 — 순수 **표시 정밀도 갭**.

## 레일 / 불변 (둘 공통)

- **#1/#2**: 잡 spawn 0. 슬라이스 A=읽기 전용 listing 확장, 슬라이스 B=순수 표시. 자동 실행/적용 경로 없음.
- **#7**: 마이그레이션/표 0 — 디스크 유도. 슬라이스 A는 기존 스캔 결과 필터만 완화, B는 FE 표시만.
- **C6**: 경로/멤버십/divergence status의 단일 출처는 백엔드(`scan.rs`/`divergence.rs`). FE는 조인·표시만 —
  경로추론 도입 금지.
- **C7**: `memberPath`/절대경로는 로그 금지(화면 표시 전용).
- **bindings drift 0**: 두 슬라이스 모두 IPC 시그니처/타입 변경 없음(A=기존 `SkillWorkspace` 그대로
  `skill_count:0` 포함, B=Rust 무변경).

**한 PR=한 관심사** → 두 슬라이스는 **별도 커밋**으로 나눈다.

---

## 슬라이스 A — 0-스킬 프로젝트 vendoring (#5)

### 근본 원인 (소스 확정)

- `scan.rs::repo_skill_roots`(주석 line 71-73)는 **존재하지 않는 dir도 후보 루트로 합성**한다(스캔이
  graceful skip). → enabled `Provider::Local` + 비어있지 않은 `local_path`인 레포는 `.claude/skills`가
  물리적으로 없어도 루트 비지 않음.
- 따라서 `list_skill_workspaces_core`(scan.rs:317)의 `roots.is_empty()` 가드(320-323)는
  **Github/비활성/빈경로만** 제외한다.
- 0-스킬 Local repo를 막는 **유일한 지점 = line 325 `if skills.is_empty() { continue }`**.

### 변경

**백엔드 (1곳):** `list_skill_workspaces_core`에서 `skills.is_empty()` early-continue(325-327) 제거.
`roots.is_empty()` 가드(320-323)는 **유지**. 결과: enabled Local repo가 스킬 0개면
`SkillWorkspace { repo_id, label, root_path, skill_count: 0, member_paths: [] }`로 포함.

**FE (코드 변경 0):**

- `buildVendorTargets`(skillEnvNav.ts:195)는 `workspaces`를 map하며 멤버를 보지 않는다 →
  0-스킬 워크스페이스는 divergence 미수록이라 `state: "absent"` → VendorPanel "복사" 버튼 자동 노출.
  (기존 테스트 skillEnvNav.test.ts:211가 이미 빈-멤버 워크스페이스로 검증 중 → 무회귀.)
- `buildSkillWorkspaceNav`(skillEnvNav.ts:93): 빈 `memberPaths` → match Set 비어 아무 스킬도 매칭 안 함
  → 사이드바에서 선택 시 기존 "이 환경에 스킬이 없습니다" 빈 상태(정상).
- vendoring 직후 스캔이 새 카피를 발견 → 다음 listing에서 skill_count=1(자가 일관).

### 사용자 결정 (반영)

0-스킬 프로젝트를 vendor 타깃뿐 아니라 **좌측 워크스페이스 사이드바 뷰(#16)에도 노출** — 단일
워크스페이스 소스 유지(C6), 최소 변경. (대안=뷰는 스킬>0만 두고 vendorable-repo 별도 소스 → 두 곳
귀소·커맨드 추가 → 기각.)

### 테스트 (TDD)

- **Rust** (`scan.rs` 테스트 모듈):
  - RED→GREEN: enabled Local repo, 스킬 dir 미존재 → `list_skill_workspaces_core`가 `skill_count:0`·
    `member_paths:[]`로 **포함**(기존 "0-스킬 제외" 기대 테스트가 있으면 그것을 갱신).
  - 가드 유지: `Provider::Github` / `enabled:false` / 빈 `local_path` 레포는 여전히 **제외**.
  - 기존 "스킬 있는 repo" 테스트 무회귀.
- **FE**: 기존 `buildVendorTargets`/`buildSkillWorkspaceNav` 테스트 그대로 green(추가 불요 — 동작 변경
  없음). 필요 시 "빈-멤버 워크스페이스 → absent 타깃" 단언이 이미 존재함을 확인.

### 게이트

`cargo test`(+신규 Rust 테스트) · `clippy --all-targets -D warnings` · `fmt --check` ·
`pnpm typecheck`/`lint`(0err/2 baseline)/`vitest run` · **bindings drift 0**.

---

## 슬라이스 B — per-location divergence 귀속 (#6)

### 현재 / 갭

- 카드 마커(SkillsView.tsx:696-702): `g.locations.some(l => l.sourcePath && divergedPaths.has(l.sourcePath))`
  → 단일 "·다름" 배지(tooltip "중앙 라이브러리와 다름"). **어느 location이 diverged인지 미표시.**
- `divergedPaths`(`buildDivergedPathSet`)는 status=diverged인 `memberPath` Set일 뿐 → 귀속 정보 손실.
- 데이터는 이미 충분: `SkillDivergence { memberPath, repoId, name, provider, status }`(location별) +
  `SkillWorkspace { repoId, label }`(repoId→라벨).

### 변경 (FE 전용)

- **새 순수 헬퍼** `skillEnvNav.ts::buildDivergedLocationLabels(divergences, workspaces)`
  `→ Map<string /*memberPath*/, string /*projectLabel*/>`:
  - status=diverged인 divergence만.
  - `memberPath → repoId → workspaces의 label` 조인. label 미발견(이론상 없음 — A 이후 모든 Local repo가
    워크스페이스)은 `repoId` 폴백.
  - `divergences`/`workspaces` undefined → 빈 맵(graceful).
- **카드 마커**(SkillsView.tsx:696-702): diverged location들을 수집해 **프로젝트명 표기**.
  - `const divergedHere = g.locations.filter(l => l.sourcePath && divergedPaths.has(l.sourcePath))`
  - 라벨 = `divergedHere`의 `sourcePath`를 `locationLabels`로 매핑(dedupe).
  - 표시 규칙: 0건=마커 없음 · 1건=`·다름 (Alpha)` · N건=`·다름 (N)` + tooltip="중앙과 다름: Alpha, Beta".
  - 라벨 미상(맵 미스)이면 그냥 `·다름`(현 동작) 폴백 — 회귀 없음.

### 불변 / 안전

- 순수 표시 — 변이/네트워크/잡 0. status는 여전히 백엔드 단일 출처(C6), FE는 repoId→label 조인만.
- `memberPath`는 **표시에 직접 노출하지 않음**(프로젝트 *라벨*만 표기) · 로그 금지(C7).
- bindings/Rust/마이그레이션 무변경(#7).

### 테스트 (TDD)

- **FE** (`skillEnvNav.test.ts`): `buildDivergedLocationLabels`
  - RED→GREEN: diverged divergence가 repoId로 워크스페이스 label에 조인 / in_sync 제외 / undefined→빈맵 /
    label 미발견 시 repoId 폴백.
- 카드 표기 자체(렌더)는 기존 테스트 컨벤션(순수헬퍼 단위 + 코드검사)대로 — RTL 미도입 유지.

### 게이트

`pnpm typecheck`/`lint`(0err/2 baseline)/`vitest run`(+신규 헬퍼 테스트) · **bindings drift 0**(Rust
무변경 → cargo 불요, 단 전체 회귀 확인용 `cargo test`는 1회 실행).

---

## 진행 순서

1. 슬라이스 A: Rust TDD → 게이트 → 커밋 `feat(skills): G3 ff — list 0-skill projects as vendor targets`.
2. 슬라이스 B: FE TDD → 게이트 → 커밋 `feat(skills): G3 ff — per-location divergence attribution on cards`.
3. 각 슬라이스 **별도 critic(opus) ACCEPT** 후에만 done. `docs/decisions.md` breadcrumb 한 줄씩.
4. push는 **사용자 명시 요청 시에만**(현 정책).

## 비대상 (명시적 defer 유지)

- "newer 감지"/방향성·`sync_metadata` 저장 상태 → #7 재검토(ADR급) 필요. 본 fast-follow 범위 밖.
- per-file 선택 / 3-way merge → YAGNI(정본 #22 일관).
- 에이전트 dir sync(심링크라 발산 불가 — 갭 아님).
- 라이브 `tauri dev` 스모크(에이전트 환경 불가 → 사용자/cmux).
