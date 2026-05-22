# macOS 코드서명 — keychain 프롬프트 안정화 (Phase 14)

> 목적: 매 리빌드마다 macOS keychain이 암호를 다시 묻는 문제를 없앤다.
> 이 문서는 **설정 절차**다. 실제 "더 이상 안 뜸"은 **사용자 관찰**(머신/인증서 의존)이라
> 헤드리스로 검증할 수 없다 — Phase 14 done-criteria의 user-observation 항목.

## 증상 / 근본 원인

keyring(`keyring` 크레이트, `apple-native`)은 토큰을 macOS keychain에 저장한다. keychain ACL은
앱 바이너리의 **코드 서명 아이덴티티**에 묶인다. `cargo build`/`pnpm tauri dev`로 매번 리빌드하면
**서명이 ad-hoc(매번 다른 서명)**이라 ACL이 무효화되고, OS가 "이 항목에 접근하려는 새 앱"으로 보아
매번 keychain 암호를 묻는다.

→ **안정된 서명 아이덴티티**로 서명하면 ACL이 유지되어 프롬프트가 사라진다.

## 설정 (Apple Developer 계정이 있는 경우)

1. `security find-identity -v -p codesigning` 으로 "Developer ID Application" 또는
   "Apple Development" 아이덴티티 이름을 확인한다.
2. 빌드 시 환경변수로 지정한다 (Tauri가 `tauri.conf.json`의 `bundle.macOS.signingIdentity`보다
   환경변수를 우선 적용):

   ```bash
   export APPLE_SIGNING_IDENTITY="Apple Development: Your Name (TEAMID)"
   pnpm tauri dev   # 또는 pnpm tauri build
   ```

   또는 `src-tauri/tauri.conf.json`의 `bundle.macOS.signingIdentity`를 그 이름으로 채운다.

## 설정 (Apple Developer 계정이 없는 경우 — self-signed cert)

무료로 **안정된 self-signed 코드서명 인증서**를 keychain에 만들어 그걸로 서명한다. ACL이
이 안정 아이덴티티에 묶이므로 리빌드해도 프롬프트가 안 뜬다.

1. **인증서 생성** — `Keychain Access.app` → 메뉴 *Certificate Assistant ▸ Create a Certificate…*
   - Name: `Work Radar Dev` (예시)
   - Identity Type: **Self Signed Root**
   - Certificate Type: **Code Signing**
   - "login" keychain에 저장.

   CLI로도 가능하다(예: `openssl`로 키/인증서 생성 후 `security import`로 login keychain에
   넣고 코드서명 신뢰를 설정). GUI 경로가 가장 단순하다.

2. **서명 아이덴티티 확인**:

   ```bash
   security find-identity -v -p codesigning
   #   1) ABCD...  "Work Radar Dev"
   ```

3. **빌드 시 지정**:

   ```bash
   export APPLE_SIGNING_IDENTITY="Work Radar Dev"
   pnpm tauri dev
   ```

   또는 `tauri.conf.json`의 `bundle.macOS.signingIdentity`를 `"Work Radar Dev"`로 채운다.

4. **(선택) keychain ACL 신뢰 한 번 부여** — 첫 실행 시 프롬프트에서 *항상 허용(Always Allow)*을
   누르면 이후 그 안정 아이덴티티로 서명된 빌드는 다시 묻지 않는다.

## 왜 config에 하드코딩하지 않았나

`tauri.conf.json`은 저장소에 커밋된다. 특정 인증서 이름을 하드코딩하면 그 인증서가 없는 다른
머신/CI에서 `cargo build`/`tauri build`가 **깨진다**. 그래서 커밋된 config는
`bundle.macOS.signingIdentity: null`(명시적 미지정)로 두고, 안정 서명은 위처럼 **환경변수
(`APPLE_SIGNING_IDENTITY`)** 또는 각 사용자가 로컬에서 채우는 방식으로 적용한다. Tauri는
환경변수를 config보다 우선 적용한다.

## 검증 (사용자 관찰)

헤드리스로는 확인 불가. 사용자가:
1. 위 설정으로 `pnpm tauri dev` 1회 실행 → keychain 프롬프트에서 *항상 허용*.
2. 코드 수정 후 **리빌드** → keychain 토큰 접근(예: Test ping) 시 **암호 프롬프트가 안 떠야** 한다.

→ 뜨지 않으면 done. 머신/인증서 상태에 따라 다르므로 코드 변경만으로 "고쳤다"고 단정하지 않는다.
