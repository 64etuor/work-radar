# Phase 10 — Google Calendar 연동 (read 레일) · 설계 & 구현 계획

> **이 문서는 새 세션 진입점이다.** Phase 10을 처음부터 끝까지 이전 대화 컨텍스트 없이
> 구현할 수 있도록 작성됨. 먼저 `docs/HANDOFF.md` → `PLAN.md`(§1 INVARIANTS + Phase 10)
> → 이 문서 → `docs/decisions.md`(Phase 10 Google Calendar 항목) 순으로 읽는다.
>
> 상태: **설계 확정(2026-05-21, 사용자 결정), 구현 전.** 옛 Phase 10(실행 레일)은 폐기됨
> (`PLAN.md` 부록 / `docs/decisions.md`). 이 문서가 가리키는 Phase 10은 캘린더 read 레일이다.

---

## 0. 새 세션 시작 방법

```
work-radar Phase 10 (Google Calendar 연동 — read 레일) 구현. 한 번에 한 PR.
docs/specs/phase-10-google-calendar.md 를 정본으로 따른다. PR1(10a OAuth 연결) → PR2(10b 캘린더 선택+이벤트) 순.
PLAN.md §1 INVARIANTS 준수(토큰 keychain·렌더러 미노출, 외부호출 Rust, bounded·graceful degrade, read-only).
선례 코드: src-tauri/src/{notion.rs(reqwest 클라이언트+bounded retry+트레잇 seam), github.rs(with_retry/PrProvider),
keychain.rs(set/get/has/delete + TokenKind), commands.rs(set_project_token/ping_project_token/refresh_pr_radar 패턴)}.
작업/푸시는 dev에만. 각 PR done-criteria로 자가검증 후 INVARIANTS reviewer 패스.
```

---

## 1. 목표 & 범위

**Goal:** 프로젝트별 Google Calendar OAuth 연결 → 다중 캘린더 선택 → **오늘 이벤트 read**.
개인/업무 프로젝트가 각자 Google 계정·OAuth 자격증명을 **분리**해서 가진다. PR Radar처럼
**ambient read**(이벤트는 DB 영속 없음, 매 호출 fresh fetch). 선택한 캘린더 목록만 SQLite에 영속.

**소비처:** Today/Timeline(**Phase 11**). 이 Phase는 **Settings 연결 + 선택 + `fetch_calendar_events`
커맨드까지만**. Today UI는 Phase 11에서 이 커맨드를 소비한다 (한 PR = 한 관심사).

**스코프 = 2개 PR:**

| PR | 이름 | 내용 |
|---|---|---|
| **10a** | OAuth 연결 | `TokenKind::GoogleCalendar`, 사용자 제공 client(Settings 입력), loopback+PKCE OAuth(`calendar.readonly`), 토큰 refresh, connect/disconnect/status 커맨드 + Settings 연결 UI. graceful degrade. |
| **10b** | 캘린더 선택 + 이벤트 | migration 0006(`projects.google_calendar_ids`), calendarList 조회 + 다중 선택 저장, `fetch_calendar_events`, `CalendarProvider` 트레잇 + Http 구현, Settings 다중 캘린더 picker. |

**범위 밖(명시):** Today/Timeline 표시(Phase 11), 캘린더 write/이벤트 생성(read-only), .ics·CalDAV·타 제공자
(Google 전용), 실시간 push 알림(폴링만), 다계정 단일 프로젝트(계정=프로젝트 단위).

---

## 2. 사용자 결정 (설계 선결, 2026-05-21 AskUserQuestion)

1. **인증 = 풀 Google OAuth** (비공개 iCal URL·access token 붙여넣기 아님). Auth Code + PKCE, loopback redirect (RFC 8252 installed-app).
2. **OAuth client = 사용자 제공** (앱 번들 공유 client 아님). 각 사용자가 Google Cloud Console에서 **Desktop OAuth client**를 만들어 client_id/secret을 Settings에 입력. 공유 secret·verification 부담 없음, 각자 할당량/동의 소유.
3. **계정 분리 = 프로젝트별** (앱 전역 1개 아님). 개인 프로젝트 → 개인 Google 계정, 업무 프로젝트 → 업무 계정. 기존 `projects.credential_ref` + keychain 패턴(Notion/GitHub 토큰)에 그대로 얹는다.
4. **캘린더 = 프로젝트별 다중 선택**. 연결 후 calendarList를 불러 포함할 캘린더(primary + 업무/개인/구독 등)를 다중 체크.
5. **이벤트 = ambient read-only** (영속 없음, Acceptance 불요 — PR Radar 선례). 선택 목록만 SQLite 영속.

---

## 3. 아키텍처 / 모듈

기존 read-레일 패턴(Notion/PR Radar)을 그대로 따른다. 외부 호출은 Rust(reqwest), 토큰은 keychain.

- **`src-tauri/src/calendar.rs` (신설):** Google OAuth + Calendar API 클라이언트.
  - `GithubError`/`NotionError`처럼 자체 `CalendarError { Transient, Terminal }` + bounded `with_retry`(github.rs와 동일 패턴; 공통화는 추후 — 모듈별 재시도 관심사 분리 선례).
  - **OAuth 순수 헬퍼(단위 테스트):** `gen_code_verifier()`, `pkce_challenge(verifier) -> base64url(sha256)`, `gen_state()`, `auth_url(client_id, redirect_uri, challenge, state)`, `parse_redirect_query(request_line) -> {code, state}`(loopback GET 첫 줄 파싱).
  - **loopback:** `run_loopback(timeout) -> (port, code)` — tokio `TcpListener`(127.0.0.1:0 임의 포트) 단일 GET 요청 수신 후 간단 HTML 200 응답·종료. bounded timeout(예 180s)·취소 가능. 웹 프레임워크 없음.
  - **HTTP:** `exchange_code(...)`/`refresh_access(...)`(token endpoint), `list_calendars(access)`, `fetch_events(access, cal_id, time_min, time_max)`. reqwest(12s timeout, rustls).
  - **트레잇 seam:** `CalendarProvider`(RPITIT, PrProvider/NotionReader 패턴) — `exchange_code`/`refresh_access`/`list_calendars`/`fetch_events`. 코어 오케스트레이션과 파싱은 fake provider + 순수 함수로 cargo test.
- **`keychain.rs`:** `TokenKind::GoogleCalendar` 추가(account 접미사 `:google_calendar`). 값은 JSON blob `{clientId, clientSecret, refreshToken}` 1건. 기존 `set/get/has/delete_token` 재사용.
- **`models.rs`:** 신규 DTO(아래 §5). `TokenKind`에 `GoogleCalendar` 추가 + `as_str()`.
- **`commands.rs`:** §6 커맨드. 토큰은 인자/반환에 본문 없음(연결은 keychain에만).
- **`migrations/0006_*.sql` (10b):** `ALTER TABLE projects ADD COLUMN google_calendar_ids TEXT;`(JSON 배열). Phase 6 `0005`(notion_done_statuses) 선례.
- **`lib.rs`:** 신규 커맨드 등록. (선택) `CalendarManager` managed state로 access token in-memory 캐시(`Mutex<HashMap<credential_ref,(token,expiry)>>`) — 폴링마다 refresh 호출 줄임. 없으면 매 fetch refresh도 허용(bounded).

---

## 4. OAuth 흐름 (Auth Code + PKCE + loopback)

> Google "Desktop app" OAuth client. PKCE(S256) 사용. client_secret은 설치형이라 진짜 비밀은
> 아니지만 Google 토큰 교환에 포함되므로 함께 저장한다.

**연결(`start_google_oauth`):**
1. keychain에서 client_id/secret 로드(없으면 Err — 먼저 입력 필요).
2. `code_verifier`(43~128 unreserved) + `code_challenge=S256` + `state` 생성.
3. loopback 서버 bind(127.0.0.1:임의포트) → `redirect_uri = http://127.0.0.1:{port}`.
4. 시스템 브라우저로 authorization URL 열기(`tauri-plugin-opener`):
   `https://accounts.google.com/o/oauth2/v2/auth?client_id=…&redirect_uri=…&response_type=code&scope=https://www.googleapis.com/auth/calendar.readonly&code_challenge=…&code_challenge_method=S256&access_type=offline&prompt=consent&state=…`
5. 사용자 동의 → Google이 loopback로 `GET /?code=…&state=…` → 서버가 받아 code 추출(state 검증) → 200 HTML("연결됨, 창을 닫으세요") 응답 후 종료.
6. 토큰 교환 `POST https://oauth2.googleapis.com/token`(form): client_id, client_secret, code, code_verifier, grant_type=authorization_code, redirect_uri → `refresh_token`(+access_token, expires_in) 수신.
7. keychain blob에 `refreshToken` 병합 저장.

**갱신(`refresh_access`):** `POST .../token`(grant_type=refresh_token, refresh_token, client_id, client_secret) → access_token(+expires_in). refresh_token은 응답에 없을 수 있음 → 기존 유지.

**API:**
- calendarList: `GET https://www.googleapis.com/calendar/v3/users/me/calendarList`(Bearer) → items[]{id, summary, primary?}.
- events: `GET https://www.googleapis.com/calendar/v3/calendars/{cal_id}/events?timeMin=…&timeMax=…&singleEvents=true&orderBy=startTime&maxResults=50`(cal_id 퍼센트 인코딩). 이벤트 start = `start.dateTime`(timed) 또는 `start.date`(all-day).

**오늘 윈도우:** 프런트가 로컬 `date`(YYYY-MM-DD) 전달 → Rust 순수 `today_window(date, local_offset) -> (timeMin,timeMax)` RFC3339(`{date}T00:00:00{off}`~`{date}T23:59:59{off}`). 로컬 오프셋은 chrono `Local`.

---

## 5. 데이터 모델 (IPC DTO, serde camelCase + specta)

```rust
// 자격증명 blob은 keychain에만(절대 DTO/렌더러에 안 나온다).
//   keychain[{credential_ref}:google_calendar] = {"clientId":..,"clientSecret":..,"refreshToken":..}

struct GoogleCalendarStatus { connected: bool, has_client: bool, detail: String }
struct CalendarListItem { id: String, summary: String, primary: bool, selected: bool }
struct CalendarEvent {
  id: String, calendar_id: String, calendar_summary: String,
  title: String, start: String /*RFC3339*/, end: String,
  all_day: bool, location: Option<String>, url: Option<String>,
  project_id: String,
}
```
specta i64/u64 export 금지(이 Phase는 정수 필드 거의 없음 — 있으면 u32).

영속: `projects.google_calendar_ids`(0006) = 선택된 캘린더 JSON `[{id,summary}]`. 이벤트는 영속 안 함.

---

## 6. IPC 커맨드

**10a:**
- `set_google_oauth_client(project_id, client_id, client_secret) -> ()` — keychain blob에 client 저장(반환 없음).
- `start_google_oauth(project_id) -> ()` — loopback OAuth 실행, refresh_token 저장. bounded timeout.
- `google_calendar_status(project_id) -> GoogleCalendarStatus` — has_client(client 입력됨) / connected(refresh_token 있음).
- `disconnect_google(project_id) -> ()` — keychain blob 삭제.

**10b:**
- `list_google_calendars(project_id) -> Vec<CalendarListItem>` — calendarList(저장된 선택 반영해 selected 플래그).
- `set_selected_calendars(project_id, calendar_ids: Vec<String>) -> ()` — `google_calendar_ids` 저장.
- `fetch_calendar_events(project_id: Option<String>, date: String) -> Vec<CalendarEvent>` — 선택 캘린더 오늘 이벤트 시간순 병합. `None`이면 **연결된 모든 프로젝트** 병합(Today용). 미연결/실패 프로젝트는 건너뛴다(부분 실패 격리).

---

## 7. 프런트 (Settings only — Today는 Phase 11)

- `SettingsView`의 프로젝트 카드에 "Google Calendar" 블록:
  - **10a:** client_id/secret 입력(type=password, 저장 직후 비움 — `set_project_token` UX 선례) → "연결"(`start_google_oauth`) → 상태 배지(connected/미연결, graceful degrade 안내) → "연결 해제".
  - **10b:** 연결됨이면 calendarList 다중 체크박스 + "저장"(`set_selected_calendars`).
- `src/lib/query.ts` 훅: `useGoogleCalendarStatus`, `useSetGoogleOauthClient`, `useStartGoogleOauth`, `useDisconnectGoogle`, `useGoogleCalendars`, `useSetSelectedCalendars`, `fetchCalendarEvents`(Phase 11이 쓸 fetch 헬퍼). 토큰 본문은 캐시 미저장.
- bindings.ts는 `cargo test` export로 생성(수기 IPC 타입 금지).

---

## 8. 테스트 전략 (헤드리스 한계)

- **순수 함수 단위 테스트:** `pkce_challenge`(고정 verifier→알려진 S256 base64url), `auth_url`(파라미터 조립), `parse_redirect_query`(정상/누락/state 불일치), `today_window`(오프셋·경계), `parse_calendar_event`(dateTime vs date all-day, 누락 관용), `parse_calendar_list`(primary/selected), `merge_sort_events`(다중 캘린더 시간순), `CalendarError` 분류(429/5xx=Transient, 4xx=Terminal).
- **트레잇 seam:** `fetch_calendar_events` 코어를 `CalendarProvider` fake로 검증 — 다중 프로젝트 병합·정렬·**프로젝트별 부분 실패 격리**·미연결 스킵·빈 선택 시 빈 결과.
- **사용자 관찰 항목(헤드리스 불가):** 실 OAuth loopback·브라우저 동의·실 Google fetch·keychain 영속·재부팅 유지. (Notion/GitHub/codex 선례와 동일 — cargo test에 실 네트워크/keychain/OAuth 없음.) `pnpm tauri dev`로 Settings 연결→calendarList→fetch 확인.

---

## 9. INVARIANTS 매핑

- **#2 Acceptance:** read-only(`calendar.readonly`) → 외부 mutate 0 → Acceptance 불요(PR Radar/mismatch read 선례). 캘린더 write 경로 없음.
- **#5 bounded:** OAuth/토큰/이벤트 모두 bounded(reqwest timeout + with_retry 캡 + loopback timeout). 무한 retry/poll 금지. Today 폴링은 프런트 refetchInterval(bounded).
- **#7 SSOT:** 이벤트=외부 read cache(ambient). 선택 캘린더 목록=로컬 SQLite. 토큰=keychain.
- **토큰 렌더러 미노출:** client_secret/refresh_token은 keychain에만, DTO/반환/캐시에 없음. 외부 호출은 Rust.
- **graceful degrade:** 미연결/client 미입력/네트워크 실패는 기능 비활성·부분 격리(앱 코어 정상).
- **결정 레일 무침범(#1):** 캘린더는 표시용 ambient. quadrant/분류 자동화 없음.

---

## 10. 신규 의존성 (예상)

- `sha2`(PKCE S256), `base64`(base64url) — 또는 `data-encoding`. `getrandom`(code_verifier/state CSPRNG; rand 이미 transitive면 그쪽).
- `reqwest`·`chrono`·`serde_json`·`tauri-plugin-opener`는 기존 가용. loopback은 tokio `TcpListener`(신규 dep 없음).
- 도입 시 `Cargo.toml`에 최소만 추가하고 `docs/decisions.md`에 한 줄.

---

## 11. 구현 순서 (ordered — 새 세션이 그대로 따라감)

### PR1 — Phase 10a (OAuth 연결)
1. `models.rs`: `TokenKind::GoogleCalendar`(+as_str), `GoogleCalendarStatus` DTO.
2. `keychain.rs`: GoogleCalendar account 매핑 확인(기존 set/get/has/delete 재사용). blob get/set 헬퍼(JSON 병합).
3. `calendar.rs`(신설): `CalendarError`+`with_retry`, 순수 OAuth 헬퍼(`gen_code_verifier`/`pkce_challenge`/`gen_state`/`auth_url`/`parse_redirect_query`) + 단위 테스트, `run_loopback`(bounded), `exchange_code`/`refresh_access`(reqwest), `CalendarProvider` 트레잇(이번 PR은 exchange/refresh만 구현·나머지는 10b).
4. `commands.rs`: `set_google_oauth_client`/`start_google_oauth`/`google_calendar_status`/`disconnect_google`.
5. `lib.rs`: 4커맨드 등록(+필요 시 CalendarManager state). bindings 재생성(`cargo test`).
6. 프런트: Settings 연결 블록(client 입력/연결/해제/상태) + query 훅.
7. 검증: cargo test(순수 OAuth 헬퍼) + clippy -D warnings + cargo fmt + pnpm typecheck/build. 실 OAuth는 사용자 관찰.

### PR2 — Phase 10b (캘린더 선택 + 이벤트)
1. `migrations/0006_google_calendar_ids.sql`: `projects.google_calendar_ids TEXT`.
2. `models.rs`: `CalendarListItem`, `CalendarEvent` DTO.
3. `calendar.rs`: `list_calendars`/`fetch_events` 구현 + 순수 파싱(`parse_calendar_list`/`parse_calendar_event`/`today_window`/`merge_sort_events`) + 단위 테스트.
4. `commands.rs`: `list_google_calendars`/`set_selected_calendars`/`fetch_calendar_events`(코어는 `CalendarProvider` 트레잇 의존 → fake로 병합·부분실패 격리 테스트).
5. `lib.rs`: 3커맨드 등록. bindings 재생성.
6. 프런트: Settings 다중 캘린더 picker + `fetchCalendarEvents` 헬퍼(Phase 11 소비 준비).
7. 검증: 위와 동일 + 트레잇 seam 테스트. 실 fetch는 사용자 관찰.

각 PR: done-criteria 자가검증 → INVARIANTS reviewer 패스(self-approve 금지) → `docs/decisions.md` 한 줄 → dev에 커밋.

---

## 12. Done-criteria

- [ ] (10a) Settings 프로젝트별 client 입력 → "연결" → 브라우저 동의 → refresh token keychain 저장(재부팅 유지); 미연결/client 미입력 graceful degrade; 토큰 렌더러 미노출
- [ ] (10a) access token 만료 시 refresh로 자동 재발급(bounded, 무한 retry 아님)
- [ ] (10b) 연결 후 calendarList 표시 + 다중 캘린더 선택 저장(개인/업무 계정 분리)
- [ ] (10b) `fetch_calendar_events(date)`가 개인+업무 선택 캘린더 오늘 이벤트를 시간순 병합 반환(all-day 포함)
- [ ] (10b) 미연결/네트워크 실패 프로젝트는 격리(나머지 정상)
- [ ] 파싱·오늘 윈도잉·PKCE(S256)·병합/정렬은 cargo test green; 실 OAuth loopback·실 Google fetch·keychain 영속은 사용자 관찰 항목

---

## 13. 환경 함정 (HANDOFF 운영 노트 발췌)

- **cargo PATH:** `export PATH="$HOME/.cargo/bin:$PATH"` 후 cargo / `git commit`(husky pre-commit = cargo fmt --check + pnpm typecheck). cargo는 `--manifest-path src-tauri/Cargo.toml`.
- **rtk 훅:** `cargo clippy … -- -D warnings`·`tail`·`cat`은 `rtk proxy <cmd> > /tmp/x.log 2>&1` 후 Read 도구로 raw 확인(가짜 exit 0 주의).
- **bindings.ts:** `cargo test` export가 생성. 수기 IPC 타입 금지. specta i64/u64 export 금지(→ u32). f64 비-Option은 `number|null`로 export → 프런트 `?? 0` 가드.
- **Git:** 작업/푸시는 **dev에만**(main은 PR-only, husky pre-push 차단). Conventional Commits. 한 PR=한 관심사.
- **GUI/실네트워크/실 OAuth/keychain:** 사용자 관찰 항목 — cargo test에 넣지 말 것.

---

## 14. 미해결 / 관찰 항목 (구현 중 결정)

- **access token 캐시 위치:** CalendarManager in-memory(`Mutex<HashMap>`) vs 매 fetch refresh. 폴링 빈도 보고 결정(기본: in-memory 캐시 + expiry, miss 시 refresh).
- **client_id/secret 저장 분리:** keychain 단일 blob(clientId/secret/refreshToken) vs client는 평문 config·refresh만 keychain. 결정: **전부 keychain blob**(secret도 비밀로 취급, 단순).
- **loopback 포트/방화벽:** 127.0.0.1 임의 포트. macOS 첫 실행 시 incoming 연결 허용 프롬프트 가능 — 사용자 관찰.
- **Google verification:** 사용자 본인 Cloud client + `calendar.readonly`는 보통 "테스트 사용자"로 동의 가능(앱 게시/검증 불요). Settings 안내 문구에 명시.
- **Timeline/Weekly review(Phase 11) 정의:** 캘린더 이벤트를 Timeline 축에 어떻게 얹을지는 Phase 11 착수 시 brainstorming.
