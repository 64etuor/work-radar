# Fast-follow — 네트워크 설치 tarball 크기 상한(decompression/tar-bomb 가드)

**상태**: 설계 → 구현
**범위**: G1.5-PR1 네트워크 설치(`skills/remote.rs::extract_tarball`)의 잔여 비차단 fast-follow.
**ADR**: 0006 레일 ③(외부 fetch는 Rust, bounded). 본 변경은 **bounded only** INVARIANT의 자연스러운 완성.

## 문제

`extract_tarball`은 tar-slip(경로 탈출)은 이미 방어하지만 **압축 해제 크기에 상한이 없다**:

- 각 파일 엔트리를 `read_to_end`로 **무제한** 메모리에 읽는다.
- 엔트리 개수 상한이 없다.

악성/손상 tarball(decompression bomb: 수 KB → 수 GB, 또는 수백만 tiny 엔트리)이 메모리/디스크를
고갈시킬 수 있다. GitHub tarball은 실무상 작지만, 우리는 "신뢰하되 방어"한다(tar-slip과 동일 원칙).

## 설계

**가장 작은 국소 변경 · 호출자 무변경 · 백엔드 전용(커맨드/bindings/마이그레이션 0).**

1. `remote.rs`에 명명 상수 2개 추가(가드, 쿼터 아님 — 튜닝 가능):
   - `MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 256 MiB` — 전체 압축 해제 바이트 상한.
   - `MAX_ARCHIVE_ENTRIES: usize = 100_000` — 엔트리(파일+디렉터리) 개수 상한.
   - 실제 스킬 repo는 이보다 훨씬 작다(여유 있음). bomb는 GB/수백만 단위라 차단된다.
2. 주입 가능한 코어 `extract_tarball_capped(gz, max_total_bytes, max_entries)`로 추출 로직 이동
   (코드베이스 `_core`/주입 관례 — 작은 상한으로 빠른 단위 테스트). `extract_tarball`은 상수로 위임만.
3. 코어에서:
   - 엔트리마다 `entry_count += 1`; `> max_entries`면 `Terminal("too many archive entries")`.
   - 파일 엔트리는 `remaining = max_total - total` 계산 후 `(&mut entry).take(remaining + 1)`로 읽어
     **버퍼 할당을 상한+1로 bound**(피크 메모리 ≤ 상한). `buf.len() > remaining`이면
     `Terminal("archive too large")`. 아니면 `total += buf.len()`.
   - tar-slip/top-level/쓰기 로직은 그대로(행동 무변경).

## 비목표

- 스트리밍-투-디스크 카운팅 라이터(피크 메모리를 상한보다 더 낮추기) — 더 큰 리팩터, YAGNI. take-bound로 충분.
- per-file 별도 상한 — total 상한이 단일 버퍼를 이미 bound.
- 설정 가능 UI — 가드는 상수면 충분.

## 검증

- TDD: 초과-총량 거부 / 초과-엔트리수 거부 / 상한 내 정상 추출(작은 상한으로 빠르게).
- 기존 `extract_tarball_*` 테스트(top-level/tar-slip) 회귀 없음.
- cargo test + clippy -D warnings + fmt; bindings drift 0(Rust 내부, IPC 무변경).
- 별도 critic(opus) 패스 ACCEPT.
