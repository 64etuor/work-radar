# dev 빌드 코드서명 — 키체인 권한 영구 유지

> macOS 한정. `pnpm tauri dev` 전에 `pnpm tauri:dev:setup`을 1회 실행한다.

## 왜 필요한가

`pnpm tauri dev`는 cargo로 dev 바이너리를 다시 만든다. macOS 키체인은 “이 바이너리(designated requirement)가 접근 가능”인지 cdhash/identifier/서명 identity로 판단한다. rebuild마다 cdhash가 바뀌면 미서명/ad-hoc 바이너리는 `Always Allow`가 반복 무효화된다.

해결책: dev 바이너리를 실행하기 **전에** 항상 같은 self-signed identity로 서명한다. Apple Developer 계정은 필요 없다.

## 1회 setup

```bash
pnpm tauri:dev:setup
```

스크립트가 수행:

1. 전용 dev keychain 생성/잠금 해제: `~/Library/Keychains/work-radar-dev.keychain-db`
2. self-signed code signing cert + private key 생성(CN=`Work Radar Dev`)
3. 전용 keychain에 identity import
4. codesign partition list + codeSign trust 등록
5. `/usr/bin/true` 복사본에 실제 `codesign` smoke test 실행

완료 조건은 `find-identity`가 아니라 **실제 codesign smoke test 통과**다.

## 사용

```bash
pnpm tauri dev
```

`pnpm tauri dev`는 repo-local wrapper를 통해 macOS에서 자동으로 pre-launch signing runner를 쓴다. 예전 명시적 alias도 유지된다:

```bash
pnpm tauri:dev:signed
```

일시적으로 원래 unsigned dev가 필요하면:

```bash
WORK_RADAR_UNSIGNED_DEV=1 pnpm tauri dev
```

## 확인

```bash
security find-identity -p codesigning "$HOME/Library/Keychains/work-radar-dev.keychain-db"
codesign -dv --verbose=2 src-tauri/target/debug/work-radar 2>&1 | grep -E "Authority|Identifier"
```

기대값:

- `Authority=Work Radar Dev`
- `Identifier=co.kr.mirrorless.workradar`

## 재생성

전용 keychain 상태가 꼬이면 삭제 후 다시 setup:

```bash
security delete-keychain "$HOME/Library/Keychains/work-radar-dev.keychain-db"
pnpm tauri:dev:setup
```

기존 login keychain에 남은 `Work Radar Dev` cert/private key는 더 이상 사용하지 않는다. runner는 전용 keychain의 identity hash만 사용한다.

## 기존 work-radar 토큰 ACL 정리(옵션)

이전에 미서명/ad-hoc dev로 저장한 토큰이 있다면 ACL이 옛 cdhash에 묶여 있을 수 있다. 첫 접근 때 한 번 `Always Allow`를 누르거나, 앱 설정에서 토큰을 삭제 후 재등록한다.

## Troubleshooting

| 증상 | 원인 / 대응 |
|---|---|
| `전용 dev keychain에서 사용할 수 없습니다` | `pnpm tauri:dev:setup` 실행. |
| `unlock 실패` | 전용 keychain이 이전 비밀번호로 생성됨. `security delete-keychain "$HOME/Library/Keychains/work-radar-dev.keychain-db" && pnpm tauri:dev:setup`. |
| `codesign smoke test 실패` | setup이 실패 상태를 감지한 것. 출력된 진단을 확인하고 전용 keychain 삭제 후 재생성. |
| 앱 첫 토큰 접근 때 1회 prompt | 기존 토큰 ACL이 옛 바이너리에 묶임. `Always Allow` 1회 또는 토큰 재등록. |
