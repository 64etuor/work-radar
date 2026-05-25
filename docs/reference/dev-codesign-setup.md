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

## 1회 setup — 자동 (권장)

GUI(Keychain Access) 단계는 macOS 버전마다 위치/문구가 달라 헷갈리기 쉬워, 터미널에서
한 줄로 끝나는 자동 setup 스크립트를 제공한다.

```bash
pnpm tauri:dev:setup
```

스크립트가 수행:
1. `openssl`로 self-signed cert + private key 생성 (CN=`Work Radar Dev`, extKeyUsage=codeSigning, 10년 유효).
2. PKCS12로 묶어 login keychain에 `security import` (codesign이 private key 접근 가능하도록 `-T /usr/bin/codesign`).
3. `security set-key-partition-list`로 codesign 무인 접근 허용 (이게 없으면 서명 시 매번 비밀번호 prompt).

실행 중 macOS가 login keychain 비밀번호를 1~2회 묻는다(키체인 잠금 해제용).
멱등 — 이미 있으면 skip.

**다른 cert 이름 사용**:
```bash
WORK_RADAR_DEV_CERT="My Custom Cert" pnpm tauri:dev:setup
```

**삭제하고 다시 만들기**:
```bash
security delete-certificate -c "Work Radar Dev"
pnpm tauri:dev:setup
```

## 1회 setup — GUI fallback

자동 스크립트가 안 통하면 (예: openssl 미설치, 권한 거부) `Keychain Access.app`으로 수동
생성. macOS Sequoia 기준:

1. **Spotlight (⌘+Space)** → `Keychain Access` → Return.
2. 상단 메뉴 바: **Keychain Access → Certificate Assistant → Create a Certificate...**
3. 다이얼로그:
   - **Name**: `Work Radar Dev`
   - **Identity Type**: `Self Signed Root`
   - **Certificate Type**: `Code Signing` ⚠️ (기본 SSL Server 아님 — 꼭 바꾸기)
   - `Let me override defaults`: **체크 안 함** (체크 시 추가 화면이 줄줄이 나오니 비워두기)
4. **Create** → 경고 dialog → **Continue** → **Done**.

(GUI에서 만들 때도 `security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" ~/Library/Keychains/login.keychain-db`를 1회 실행해 두면 codesign이 비밀번호 prompt 없이 사용 가능.)

## 기존 work-radar 키체인 항목의 ACL 정리 (옵션)

이전에 미서명 dev로 저장한 토큰이 있다면 ACL이 이전 cdhash에 묶여 있을 수 있다. 둘 중 하나:

- **A. 삭제 후 재등록**: 앱 설정 → 토큰 관리에서 삭제 후 다시 입력. 첫 호출에서 "Always
  Allow" 누르면 새 cert 기반 designated requirement로 ACL 갱신.
- **B. 직접 ACL 편집**: Keychain Access에서 `co.kr.mirrorless.workradar` 검색 → 각 항목
  더블클릭 → **Access Control** 탭 → "Allow all applications to access this item" 체크 → Save.

## 사용

```bash
pnpm tauri:dev:signed
```

스크립트가 자동으로:
1. cert 존재 사전 확인 (없으면 setup 안내 후 종료)
2. `pnpm tauri dev` 백그라운드 실행
3. `src-tauri/target/debug/work-radar` mtime 폴링 → 변경 감지 시 즉시 재서명

각 키체인 항목 첫 호출 때 "Always Allow"를 한 번만 누르면, 그 이후 모든 rebuild에 권한 유지.

## 확인

```bash
# cert가 있는지
security find-certificate -c "Work Radar Dev" >/dev/null && echo OK

# codesign 사용 가능한 identity로 잡히는지
security find-identity -p codesigning -v | grep "Work Radar Dev"

# 빌드된 바이너리에 서명이 박혔는지 (tauri:dev:signed 실행 후)
codesign -dv --verbose=2 src-tauri/target/debug/work-radar 2>&1 | grep -E "Authority|Identifier"
```

## Troubleshooting

| 증상 | 원인 / 대응 |
|---|---|
| `❌ 코드서명 인증서 'Work Radar Dev'가 키체인에 없습니다` | Setup 미진행. `pnpm tauri:dev:setup` 실행. |
| `⚠️ codesign 실패` 로그 반복 | cert가 "Code Signing" 용도가 아니거나 partition list 미설정. 위 "확인" 명령으로 진단. |
| 재서명 후에도 매번 prompt | 기존 ACL이 옛 cdhash에 묶여 있음. "ACL 정리" 섹션 (A: 삭제 후 재등록) 진행. |
| codesign 실행 시 비밀번호 prompt | `set-key-partition-list`가 안 됨. 수동으로:`security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <login-password> ~/Library/Keychains/login.keychain-db`. |
| tauri dev가 빌드 중 종료 | 일반 cargo/vite 에러. `pnpm tauri dev` 단독 실행으로 디버깅 후 재시도. |

## release 빌드는?

`pnpm tauri build` 결과물은 한 번만 만들어 그대로 쓰므로 cdhash가 고정 → "Always Allow"
영구 유지. 외부 배포가 아니라 본인 dogfood 용도면 별도 서명 불필요.
