# dev 빌드 코드서명 — 키체인 권한 영구 유지

> macOS 한정. `pnpm tauri:dev:signed`를 처음 쓰기 전에 1회 setup.

## 왜 필요한가

`pnpm tauri dev`는 cargo로 dev 빌드를 만든다. macOS 키체인은 "이 바이너리(designated
requirement)가 접근 가능"인지 cdhash/identifier 단위로 판정한다. cargo가 rebuild할 때마다
cdhash가 바뀌므로:

- **미서명** dev 바이너리 → 매 rebuild마다 "Always Allow" 무효화 → 매번 권한 prompt
  (또는 macOS Sonoma/Sequoia에서 silent denial)
- **ad-hoc 서명**(`codesign --sign -`) → cdhash 변동 시 designated requirement 매칭 실패 (동일 문제)
- **self-signed cert로 서명** → designated requirement가 `Authority == "<cert name>"`로
  잡혀 cdhash 변동에도 매칭 유지 → "Always Allow" 영구 ✅

Apple Developer 가입은 **불필요**(외부 배포 안 함).

## 1회 setup (5분)

### 1. self-signed code signing 인증서 생성

`Keychain Access.app` 실행 → 메뉴 **Keychain Access → Certificate Assistant → Create a Certificate...**

| 필드 | 값 |
|---|---|
| Name | `Work Radar Dev` (다른 이름 쓰려면 `WORK_RADAR_DEV_CERT=<name>` 환경변수 설정) |
| Identity Type | **Self Signed Root** |
| Certificate Type | **Code Signing** |
| Let me override defaults | ☐ (체크 안 함) |

**Create** → admin 비밀번호 입력 → **Done**.

### 2. (선택) 인증서를 항상 신뢰

`Keychain Access` → 좌측 **login** 키체인 → **My Certificates** 카테고리에서
`Work Radar Dev` 더블클릭 → **Trust** 섹션 펼침 → "Code Signing" 을 **Always Trust** 로 설정.

### 3. (선택) 기존 work-radar 키체인 항목의 ACL 정리

이전에 미서명 dev로 저장한 토큰이 있다면 ACL이 이전 cdhash에 묶여 있을 수 있다. 둘 중 하나:

- **A. 삭제 후 재등록**: 앱 설정 → 토큰 관리에서 삭제 후 다시 입력. 첫 호출에서 "Always
  Allow" 누르면 새 cert 기반 designated requirement로 ACL 갱신.
- **B. 직접 ACL 편집**: Keychain Access에서 `co.kr.mirrorless.workradar` 검색 → 각 항목
  더블클릭 → **Access Control** 탭 → "Confirm before allowing access" 선택 + "Always
  allow access by these applications" 비우기 → Save → 다음 앱 호출 시 "Always Allow".

## 사용

```bash
pnpm tauri:dev:signed
```

스크립트가 자동으로:
1. cert 존재 사전 확인 (없으면 setup 안내 후 종료)
2. `pnpm tauri dev` 백그라운드 실행
3. `src-tauri/target/debug/work-radar` mtime 폴링 → 변경 감지 시 즉시 재서명

각 키체인 항목 첫 호출 때 "Always Allow"를 한 번만 누르면, 그 이후 모든 rebuild에 권한 유지.

## Troubleshooting

| 증상 | 원인 / 대응 |
|---|---|
| `❌ 코드서명 인증서 'Work Radar Dev'가 키체인에 없습니다` | Setup 1단계 미진행 또는 이름 mismatch. `security find-certificate -c "Work Radar Dev"` 로 존재 확인. |
| `⚠️ codesign 실패` 로그 반복 | cert가 "Code Signing" 용도가 아니거나 trust 설정 안 됨. Setup 2단계 확인. |
| 재서명 후에도 매번 prompt | 기존 ACL이 옛 cdhash에 묶여 있음. Setup 3단계 (A: 삭제 후 재등록) 진행. |
| tauri dev가 빌드 중 종료 | 일반 cargo/vite 에러. `pnpm tauri dev` 단독 실행으로 디버깅 후 재시도. |

## release 빌드는?

`pnpm tauri build` 결과물은 한 번만 만들어 그대로 쓰므로 cdhash가 고정 → "Always Allow"
영구 유지. 외부 배포가 아니라 본인 dogfood 용도면 별도 서명 불필요.
