# Work Radar — 설치·설정 가이드 (범용 사용자용)

이 문서는 원저자 환경이 아닌 **새 머신/새 사용자**가 Work Radar를 빌드·설치·설정하는
절차의 정본이다. 빌드·검증 명령의 정본은 `docs/reference/commands.md`.

## 1. 요구사항

| 구분                  | 필수 여부 | 비고                                                                |
| --------------------- | --------- | ------------------------------------------------------------------- |
| Rust (stable) + Cargo | 필수      | Tauri 백엔드 빌드                                                   |
| Node.js + pnpm        | 필수      | 프런트 빌드                                                         |
| macOS / Windows 11    | 필수      | Windows는 MSVC C++ Build Tools와 WebView2 필요                      |
| Codex CLI (`codex`)   | 선택      | 에이전트 잡 실행. 없으면 관련 기능이 "미설치"로 표시될 뿐 앱은 정상 |
| cmux / Hermes / Boule | 선택      | 원저자 스택 통합. 없어도 앱은 우아하게 동작(아래 §5)                |

## 2. 첫 실행

```bash
pnpm install
pnpm tauri dev     # 개발 모드 부팅
pnpm tauri build   # 배포용 번들
```

Windows PowerShell에서도 같은 명령을 사용한다. Tauri 실행기는 Node 기반이며, macOS 개발
코드사인 스크립트는 Windows에서 호출되지 않는다. Windows 11에는 보통 WebView2가 포함되어
있지만 빠져 있다면 Microsoft WebView2 Runtime을 먼저 설치한다.

- 데이터: SQLite 단일 파일 — `{OS app-data dir}/co.kr.mirrorless.workradar/work-radar.db`.
  스키마는 내장 마이그레이션이 첫 부팅에 자동 적용한다.
- 오버라이드: `WORK_RADAR_DEV_DB=/path/to.db` (헤드리스 MCP/프로필 환경용 — 일반 사용 불필요).
- 비밀은 전부 OS 보안 저장소(macOS Keychain / Windows Credential Manager)에 저장된다
  (SQLite 평문 금지 — 레포 불변).

첫 부팅은 빈 상태로 뜬다. **설정(macOS Cmd+, / Windows Ctrl+,) → 프로젝트**에서 첫 프로젝트를 만들면
각 뷰가 채워지기 시작한다.

## 3. 통합(Integrations) 설정 — 전부 UI에서, 코드 수정 불필요

### Notion (백로그/안건 승격)

1. Notion에서 internal integration 토큰 발급 + 대상 데이터베이스에 연결 권한 부여.
2. 설정 → 프로젝트 → 해당 프로젝트에 토큰 저장(키체인행) + 백로그/안건 DB ID 입력.

### GitHub (PR Radar)

1. PAT 발급(repo read 권한).
2. 설정 → 프로젝트 → 토큰 저장 + 감시할 레포(owner/repo) 추가.

### Google Calendar / Gmail

번들된 OAuth client가 **없다** — 각 사용자가 자기 Google Cloud 프로젝트에서 만든다:

1. [Google Cloud Console] → API 활성화(Calendar API, Gmail API).
2. OAuth 동의 화면 구성(테스트 사용자에 본인 계정 추가).
3. OAuth Client ID 생성 — 유형 **Desktop app**.
4. 설정 → 프로젝트 → Google 블록에 `client_id`/`client_secret` 저장 → "연결"로
   브라우저 동의(PKCE loopback). refresh token까지 키체인에 저장된다.

### 뉴스 티커

- 설정 → 뉴스에서 소스 on/off + 키워드 필터. 신규 설치 기본은 Hacker News/Lobsters ON,
  나머지(한국어 소스 포함) OFF.
- 소스 목록 자체는 빌드타임 상수(`src-tauri/src/news/mod.rs` registry) — 커스텀 RSS URL
  추가는 아직 UI 미지원(의도된 범위 제한).

### 가계부 기본 통화

- 가계부 → 가져오기 탭 → **기본 통화** 카드에서 ISO 4217 코드(예: USD) 저장.
  미설정 시 KRW. 통화를 지정하지 않은 새 거래·고정비·예산에 적용된다.
- MoneyManager(.mmbak) 임포트의 날짜 해석은 시스템 타임존을 따른다(하드코딩 아님).
- 한국 은행/카드 알림 메일 파서는 확장 포인트다 — 매칭 안 되는 메일은 자동으로
  `needs_review` 큐로 들어와 수동 판단으로 처리된다(기능 파손 아님).

## 4. UI 언어/로케일/타임존 현황

- UI 문안은 현재 **한국어 고정**(i18n 미도입 — 알려진 한계, deferred).
- 날짜·요일·통화 포맷은 `src/lib/localeFormat.ts`의 `APP_LOCALE` 단일 노브로 수렴돼 있다.
  i18n 도입 시 이 노브를 설정값으로 바꾸는 것이 시작점이다.
- **타임존은 설정이 없다(by design)** — 항상 OS 로컬을 따른다. Rust의 모든 로컬 시간
  파생(루틴 동기화 tzid·리마인더·mmbak 날짜 버킷·OKR/스프린트/루틴의 "오늘"·캘린더
  정규화/오프셋)은 `src-tauri/src/timezone.rs` SSOT 하나를 거치고, 감지 실패 시 UTC로
  폴백한다(지역 하드코딩 없음). OS 타임존을 바꾸면 앱 전체가 일관되게 따라온다.
  프런트도 JS `Date`/`getTimezoneOffset()`으로 동일하게 머신 파생.

## 5. 선택 통합이 없을 때의 동작 (fresh-machine 계약)

| 없는 것                | 동작                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `codex` CLI            | 에이전트 잡 버튼이 "미설치" 안내. 잡은 스폰되지 않음(fail-closed)                          |
| cmux                   | macOS 선택 통합. Windows에서는 unavailable이며 폴링은 로컬 no-op                           |
| Hermes                 | macOS 선택 통합. Windows에서는 미지원 상태를 반환하고 프로세스·글로벌 핫키를 등록하지 않음 |
| Boule(governance)      | 원저자용 macOS 통합. Windows에서는 runner와 자동 ticker를 시작하지 않음                    |
| `~/.claude`·`~/.codex` | 사용량 게이지 "정보 없음", 스킬 스캔 빈 목록                                               |
| 키체인 토큰 없음       | 각 통합 status가 "미연결"로 표시, 네트워크 호출 없음                                       |

## 6. 리브랜딩 체크리스트 (fork해서 다른 이름/ID로 배포할 때)

번들 ID(`co.kr.mirrorless.workradar`)와 앱 이름을 바꾸려면 **아래를 한 커밋에서 함께**:

1. `src-tauri/tauri.conf.json` — `identifier`, `productName`, 창 `title`.
2. `src-tauri/src/lib.rs` — `APP_BUNDLE_IDENTIFIER` (conf와 반드시 동일; 키체인 서비스명도
   이 상수를 참조한다).
3. `src-tauri/Cargo.toml` / `package.json` — 패키지 이름·설명.
4. `src-tauri/src/tray.rs` — 트레이 툴팁.
5. `scripts/dev-codesign-setup.sh` / `dev-codesign-runner.sh` — 인증서 이름·identifier.
6. `src-tauri/icons/` — 아이콘 교체.
7. HTTP User-Agent 문자열(`src-tauri/src/news/mod.rs`, `news/fetcher.rs`, `skills/remote.rs`).

⚠️ **마이그레이션 영향**: identifier가 바뀌면 (a) app-data 경로가 바뀌어 기존 DB를 새 경로로
옮겨야 하고, (b) 키체인 서비스명이 바뀌어 저장된 모든 토큰이 orphan된다(재입력 필요).
기존 설치가 있는 채로 바꾸지 말 것.

## 7. 알려진 배포 갭 (의도적으로 미해결)

- **LICENSE 없음** — 공개 배포 전 라이선스 결정 필요(소유자 판단 사항).
- 자동 업데이터/릴리스 코드사이닝 없음 — 배포는 수동 `pnpm tauri build`.
- Windows 검증은 `.github/workflows/windows-compat.yml`의 수동 `workflow_dispatch`로 수행한다.
- `governance/`는 원저자의 별도 하네스(앱 실행에 불필요) — 분리 후보.
- 전면 i18n·커스텀 RSS UI — `docs/plans/2026-07-10-generalization-plan.md` Non-goals 참조.

## 8. Windows 실기기 스모크 체크리스트

실물 Windows 11 머신에서 첫 부팅 시 아래를 순서대로 확인한다:

1. `pnpm tauri dev` 부팅 — 창 표시, 트레이 아이콘, Ctrl+Space 전역 단축키.
2. 키체인 왕복 — 설정에서 토큰 저장 후 재시작해도 유지(Windows Credential Manager,
   `자격 증명 관리자`에서 `co.kr.mirrorless.workradar` 확인).
3. 스킬 적용 — 개발자 모드 **꺼진** 상태에서 스킬 적용/해제(junction 폴백 검증,
   `dir` 출력에 `<JUNCTION>` 표시).
4. Codex 감지 — npm 전역 설치(`codex.cmd`)가 에이전트 설정에서 감지되는지.
5. mmbak 임포트 — 파일 대화상자에서 `.mmbak` 선택 → 미리보기까지.
6. cmux/Hermes/Boule 패널 — "지원되지 않음" 안내가 뜨고 앱이 정상 동작하는지.
