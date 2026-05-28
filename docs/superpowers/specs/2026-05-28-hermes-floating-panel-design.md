# Hermes Floating Panel + ACP Chat — Design

Date: 2026-05-28
Status: Draft → awaiting user review
Branch: `feat/hermes-floating` (off `dev@d739e56`)

## 1. Problem

현재 `HermesView`는 Telegram 봇 브릿지 UI(메시지 로그 + 봇으로 보내기)다. 다음 문제·요구가 동시에 있다:

- 모달 등장 위치가 어색하다 (shadcn `Dialog`로 화면 중앙 고정, fixed sizing).
- 사용자가 패널을 자유롭게 이동하고 싶다.
- 토글 단축키가 없고, 단축키를 사용자 정의하고 싶다.
- 로컬에 설치된 **Nous Hermes Agent CLI**(`/Users/davidpark/.local/bin/hermes`)와 work-radar에서 직접 대화하고 싶다.
- `/` 슬래시 명령과 이미지 paste를 지원해야 한다.
- Settings에서 Hermes CLI 감지·자동 연결 상태를 보여줘야 한다.

## 2. Goals / Non-Goals

**Goals**

- 모달 → 자유 이동·리사이즈 가능한 in-renderer 플로팅 패널로 전환.
- OS 글로벌 단축키 토글 (기본 `Cmd+Shift+H`, Settings에서 재설정 가능).
- 위치·크기·열림 상태 영구 저장.
- `hermes acp` 자식 프로세스를 통해 stdio JSON-RPC로 Hermes Agent와 양방향 통신.
- 스트리밍 채팅, 슬래시 명령 자동완성(ACP `available_commands` 그대로), 이미지 입력(paste/drag-drop/file picker).
- Settings에 Hermes CLI 감지·ACP 준비 상태 표시 블록.

**Non-Goals**

- 채팅 히스토리 영구 저장(in-memory only; `--resume`/`--continue`는 후속).
- 모델·프로바이더 선택 UI(터미널에서 `hermes login` / `hermes model`로 처리).
- `hermes setup` 마법사 GUI화.
- Telegram 브릿지 제거 — Settings에는 잔류, 메인 HermesView에서만 제거.
- 멀티 세션·멀티 패널.

## 3. Decisions (high-level)

| Decision | Value | Why |
|---|---|---|
| Hermes IPC | ACP (`hermes acp` stdio JSON-RPC) | Hermes가 IDE 통합용으로 미는 표준 프로토콜; 세션·스트림·툴콜·이미지 1급. |
| HermesView | 완전 교체 (ACP 채팅이 자리 차지) | Telegram 브릿지와 채팅 패널은 성격이 달라 같은 뷰에서 공존하기 어색. |
| Panel state 영속 | `app_config` JSON blob (`hermes.panel`) | 기존 settings 스토리지 재사용, 마이그레이션 불필요. |
| Toggle hotkey | OS 글로벌 (`tauri-plugin-global-shortcut`) | 다른 앱에서도 호출 가능. 기존 `nav.global_hotkey` 인프라 재사용. |
| Slash commands | ACP `available_commands` 자동 노출 | 자체 정의 시 hermes 명령과 어긋남. ACP가 권위. |
| Image input | paste + drag-drop + file picker 3종 | 사용자 명시 요구. |
| Hermes 감지 | 자동 + 재감지 버튼만 (login/setup 없음) | 사용자가 터미널에서 직접 setup 한다는 전제. |

## 4. Architecture

### 4.1 Rust 신규 모듈 — `src-tauri/src/hermes_agent/`

```
src-tauri/src/hermes_agent/
  mod.rs            // public surface, state, lifecycle
  acp_client.rs     // tokio::process child + JSON-RPC frame pump
  detect.rs         // hermes_detect()
```

- **`AcpSession`**: `Mutex<Option<…>>` 보유. 한 번에 한 자식.
  - `child: tokio::process::Child`
  - `stdin_tx: mpsc::Sender<Vec<u8>>` (write task)
  - `pending: HashMap<RequestId, oneshot::Sender<JsonValue>>`
  - `session_id: String`
  - `available_commands: Vec<AcpCommand>` (캐시)
- **수명**: `hermes_agent_start` 호출 시 spawn → ACP `initialize` → `session/new` → `available-commands` emit → ready. `hermes_agent_stop` 또는 앱 종료 시 `child.kill().await`.

### 4.2 신규 IPC 커맨드 (`src-tauri/src/commands/hermes_agent.rs`)

전부 `Result<_, AppError>`, `#[tauri::command] #[specta::specta]`.

| Command | In | Out |
|---|---|---|
| `hermes_detect` | – | `HermesDetectResult { installed, version, path, acp_ready, error }` |
| `hermes_agent_start` | – | `()` (실제 데이터는 events로) |
| `hermes_agent_send` | `text: String, image_paths: Vec<String>` | `()` |
| `hermes_agent_cancel` | – | `()` |
| `hermes_agent_stop` | – | `()` |
| `hermes_panel_state_get` | – | `HermesPanelState { x, y, w, h, open }` |
| `hermes_panel_state_set` | `state: HermesPanelState` | `()` |
| `hermes_save_pasted_image` | `bytes: Vec<u8>, ext: String` | `path: String` (임시파일) |
| `hermes_get_toggle_hotkey` | – | `String` |
| `hermes_set_toggle_hotkey` | `spec: String` | `()` (글로벌 재등록) |

### 4.3 Specta 이벤트 (Rust → Frontend)

| Event | Payload |
|---|---|
| `hermes-agent:chunk` | `{ turn_id, text }` |
| `hermes-agent:tool-call` | `{ turn_id, name, args_summary }` |
| `hermes-agent:turn-end` | `{ turn_id, status: "ok" \| "cancelled" \| "error", error?: string }` |
| `hermes-agent:available-commands` | `{ commands: AcpCommand[] }` |
| `hermes-agent:session-ready` | `{ session_id }` |
| `hermes-agent:error` | `{ kind, message }` |
| `hermes:toggle` | `{}` (단축키 prss 시 frontend로) |

### 4.4 Frontend 구조 (`src/components/`)

기존 `HermesView.tsx` 완전 교체. 새 트리:

```
HermesView.tsx                  // 얇은 마운트 포인트 + 라우터 진입
  hermes/
    HermesPanel.tsx             // floating shell (drag/resize/position persist)
    HermesChatLog.tsx           // message list, streaming render
    HermesChatInput.tsx         // textarea + paste/drop/picker + / detection
    HermesSlashMenu.tsx         // command popover above input
    useHermesPanelState.ts      // SQLite-backed position/size/open
    useHermesAgent.ts           // session start/stop, send, cancel; event subscriptions
    types.ts                    // chat message types (in-memory)
```

`HermesBridgeBlock` (Settings)는 그대로 유지. 신규 `HermesConnectionBlock`을 Settings에 추가.

### 4.5 Settings: Hermes 연결 블록 (§4.5)

`src/components/settings/HermesConnectionBlock.tsx`:

- 마운트 시 `useQuery(["hermes-detect"], hermesDetect)` 자동 실행.
- 결과 분기:
  - ✓ `installed && acp_ready` → 그린 "Hermes `<version>` 감지됨 · ACP 준비 완료 · `<path>`"
  - ⚠ `installed && !acp_ready` → 옐로 "ACP 의존성 누락 — 터미널에서 `hermes acp --setup` 실행 후 재감지"
  - ✗ `!installed` → 레드 "Hermes를 찾을 수 없습니다. 설치 후 재감지하세요" + 1줄 안내
- "재감지" 버튼 = `refetch()`. 5초 타임아웃.
- 로그인/모델 설정 UI 없음. (Non-goal)

## 5. Data Model

### 5.1 `app_config` (기존 테이블)

| key | value (JSON 또는 string) |
|---|---|
| `hermes.panel` | `{"x": number, "y": number, "w": number, "h": number, "open": bool}` |
| `hermes.toggle_hotkey` | `"Cmd+Shift+H"` (기본). 기존 `set_global_hotkey` 패턴 복제. |

마이그레이션 불필요 (key-value 테이블에 새 키 삽입만).

### 5.2 In-memory chat state

```ts
type HermesMessage =
  | { role: "user"; text: string; images: string[]; ts: number }
  | { role: "assistant"; chunks: string[]; toolCalls: ToolCallSummary[]; ts: number; done: boolean }
  | { role: "system"; text: string; level: "info" | "warn" | "error"; ts: number };
```

`useReducer`로 chunk append idempotent. 재시작 시 휘발.

### 5.3 이미지 전송 페이로드

1. 클립보드 paste → `event.clipboardData.items` blob → `arrayBuffer()` → `hermes_save_pasted_image(bytes, "png")` IPC → temp path 반환.
2. drag-drop → File 객체 → 동일 흐름 (확장자 보존).
3. file picker → Tauri `dialog::open({ filters: image })` → 직접 path.

송신 시 `hermes_agent_send(text, image_paths)` 호출 → Rust가 ACP `session/prompt`로 변환:

```jsonc
{
  "prompt": [
    { "type": "text", "text": "..." },
    { "type": "image", "source": { "type": "file", "path": "/.../hermes-paste-<uuid>.png" } }
  ]
}
```

전송 직후 임시파일에 5분 TTL cleanup job 등록.

## 6. UI / UX 명세

### 6.1 `HermesPanel`

- 컨테이너: `position: fixed; transform: translate3d(x, y, 0)` (하드웨어 가속).
- 기본 위치: 첫 실행 시 우측하단(`window.innerWidth - w - 24, window.innerHeight - h - 24`), 기본 크기 `460 × 600`, min `360 × 320`.
- 드래그 핸들: 헤더 영역. `onPointerDown` → `setPointerCapture` → `pointermove`로 누적 → `pointerup`에서 `hermes_panel_state_set` debounce(300ms) 저장.
- 리사이즈 그립: 우측하단 14×14 div, 동일 패턴.
- 뷰포트 클램프: 저장 좌표가 화면 밖이면 visible 영역으로 보정 (모니터 변경 대비).
- 닫기: 헤더 X 버튼 + 입력창이 비어있고 슬래시메뉴가 닫혀있을 때 `Esc`.
- 토글: Rust → `hermes:toggle` 이벤트 listen → `open` flip + 저장.
- 기존 `data-tauri-drag-region` 제거.

### 6.2 `HermesChatInput`

- shadcn `Textarea` 베이스, auto-grow max 8줄.
- `Enter` 송신, `Shift+Enter` 줄바꿈.
- `onPaste` — clipboardData에 image MIME 있으면 즉시 IPC 저장 → 미리보기 칩 + 첨부 큐.
- `onDrop` — files 필터 `image/*`.
- "📎" 버튼 — file picker.
- `/` 감지: 커서 앞 토큰이 `/`로 시작하면 `HermesSlashMenu` 열고 prefix 필터링. `↑/↓` 네비, `Enter`/`Tab` 컴플리트, `Esc` 닫기.

### 6.3 `HermesChatLog`

- 메시지 배열 위→아래, 최신이 아래. auto-scroll-to-bottom (사용자가 스크롤 떨어뜨리면 끔).
- 스트리밍 chunk는 마지막 assistant 메시지의 `chunks[]`에 append.
- 코드블록은 `src/lib/shiki.ts` 재사용.
- tool-call은 접힌 카드(제목 + arrow), 클릭 시 args_summary 표시.
- system 메시지는 회색 배경, 한 줄.

### 6.4 Settings UI

- `HermesConnectionBlock` (신규, §4.5 명세).
- `HermesPanelSettings` (신규): 토글 단축키 캡처 위젯 (기존 `GlobalHotkeyCapture`를 prop으로 key 이름 받게 일반화) + "패널 위치 리셋" 버튼.
- `HermesBridgeBlock` (기존, 그대로 유지).

## 7. Error Handling

전부 `AppError` envelope. 새 variants:

- `AppError::HermesSpawnFailed(io::Error)` — `hermes` 바이너리 없거나 spawn 실패.
- `AppError::HermesAcpProtocol(String)` — JSON-RPC frame 깨짐 / 예상 못한 응답.
- `AppError::HermesTimeout` — initialize / session/new 5초 타임아웃.

UX 매핑:

| 상황 | 결과 |
|---|---|
| `hermes` PATH 없음 | spawn 실패 → 패널에 "Hermes CLI 미발견" 배너 + retry 버튼 |
| ACP 핸드셰이크 실패 | 토스트 + 자식 kill + 세션 nil |
| 스트림 중 자식 사망 | `turn-end` (status=error) + system 메시지, 다음 send 시 자동 재시작 |
| 30초 무응답 | 타임아웃 + 자식 kill |
| 이미지 저장 실패 | 입력창 인라인 에러, 텍스트만 송신 진행 |

**로그 정책** (PII 금지): 프롬프트 본문·응답 본문 로그 X, 길이·turn_id·tool_name만.

## 8. Hotkey 등록

- 기존 `src-tauri/src/shortcut.rs` 패턴 그대로 따라 새 함수 `register_hermes_toggle(spec)` 추가.
- 핸들러: `app.emit("hermes:toggle", ())` 만 emit (실제 토글은 frontend가).
- `hermes.toggle_hotkey`가 `nav.global_hotkey`와 동일 시 register 실패 → 에러 표시, 이전 키 유지.

## 9. PR/Commit 분할 (단일 브랜치 누적)

1. **Phase A — Panel shell + hotkey infra**: HermesView를 Dialog에서 떼어내 drag/resize 가능 플로팅 div로. OS 토글 단축키 + Settings 캡처 위젯. 위치·크기·오픈 상태 영속. 채팅 내용은 placeholder. → commit.
2. **Phase B — Hermes detect + Settings 블록**: `hermes_detect` 커맨드, `HermesConnectionBlock` UI. → commit.
3. **Phase C — Rust ACP client (backend only)**: `hermes_agent` 모듈, IPC, events, mock 단위 테스트. UI 무변경. → commit.
4. **Phase D — Wire panel to ACP**: placeholder 교체, 스트리밍, 새 세션 버튼, 에러 표시. → commit.
5. **Phase E — Slash commands + images**: `/` 자동완성, paste·drop·picker, ACP image content. → commit.

dev 진행 시 rebase. 최종 1 PR (`feat: floating hermes panel with acp chat`).

## 10. Verification

- `cargo test` — ACP frame 파싱 단위 테스트(mock stdio).
- `cargo clippy --all-targets -- -D warnings`
- `cargo fmt --check`
- `pnpm typecheck` + `pnpm lint` + `pnpm vitest run` (panel state hook, slash menu filter).
- `pnpm bindings:check` — specta drift 0.
- `pnpm tauri dev` 부팅 → 수동 스모크 시나리오:
  - 단축키로 패널 토글 5회
  - 드래그·리사이즈 후 재시작 시 위치 복원
  - Hermes 미설치 환경 시뮬레이션(PATH 비움)에서 Settings 블록 미감지 메시지
  - 채팅 한 turn 송수신, 스트리밍 보이는지
  - `/` 입력 시 명령 메뉴, Tab으로 컴플리트
  - 스크린샷 paste → 미리보기 칩 + 응답
  - Finder에서 PNG 드래그 → 동일
  - 진행 중 cancel 동작

## 11. INVARIANTS 체크리스트 (decision-rails)

- ✅ #1 자동화 → 결정 레일 침투 없음: hermes는 사용자 명시적 입력에만 응답, 자동 실행 없음.
- ✅ #2 외부 토큰 keychain: hermes auth는 hermes 본인이 관리(`~/.hermes/auth.json`); work-radar는 토큰 다루지 않음.
- ✅ #3 외부 네트워크 Rust: ACP는 stdio이지만 자식이 외부 호출. work-radar 자체는 hermes 자식만 spawn.
- ✅ #4 IPC = specta 생성 타입: 신규 커맨드·이벤트 전부 specta annotated.
- ✅ #5 bounded retry: spawn 1회 실패 시 자동 재시도 없음, 사용자 retry 필요.
- ✅ #6 SQLite 스키마 마이그레이션: `app_config` key 추가만(스키마 변경 없음).
- ✅ #7 시각 디자인 정본 DESIGN.md: shadcn 위 컴포넌트, Tailwind v4 토큰.

## 12. Risks / Open Questions

- **ACP 프로토콜 세부사항**: 실제 frame 포맷(Content-Length 헤더 여부, message types) — Phase C 진입 시 `hermes acp --check` + 빈 ACP 세션 실험으로 확정. 스펙에서 표현은 일반적 JSON-RPC로 두고, 실구현 시 ACP 명세서 확인.
- **이미지 source path 지원 여부**: ACP에서 `image` 블록이 file path를 받는지 base64만 받는지 확인 필요. base64만 가능하면 임시파일 저장 단계 생략하고 직접 인코딩.
- **단축키 충돌**: macOS Cmd+Shift+H는 시스템 단축키와 겹칠 수 있음. 기본값 충돌 시 알림 + 대체 추천.
- **모니터 좌표 클램프**: macOS multi-display에서 음수 좌표 가능 → 모든 디스플레이의 union rect 기준으로 클램프할지 primary 기준일지 결정 필요(현재: primary 기준 단순 클램프).
