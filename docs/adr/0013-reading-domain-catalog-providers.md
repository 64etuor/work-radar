# ADR-0013: Reading 도메인 — 서지 카탈로그 아웃바운드 provider + MCP 위임

- Status: accepted
- Date: 2026-07-23
- Deciders: 사용자(발주), Claude(설계·구현)

## Context

사용자가 독서 기록 도메인을 발주했다: 서지 정보를 외부 API에서 가져와 읽은 책/읽을 책을
등록하고 완독을 트래킹하며, MCP로도 노출한다(사용자 옵시디언 `200_Books` 독서 대시보드가
기능 레퍼런스). 기존 MCP 컨벤션 §7은 "새 outbound provider 추가 = ADR"을 요구한다.

## Decision

> **개정 (2026-07-23, 같은 날):** 라이브 사용에서 두 결함이 확인돼 provider 구성을 개정했다.
> ① 키리스 Google Books는 익명 공유 쿼터가 즉시 고갈된다(관측: 429 "Queries per day") —
> 기본 provider로 부적합. ② 한글 쿼리에 영문판이 앞선다(사용자: "코스모스 검색하니까 영문이").
> 개정 결정: **알라딘 TTB를 1순위**(무료 키 — keychain 앱 전역 시크릿 `app:aladin_ttb`,
> 설정→통합에서 등록, `ItemSearch`/`ItemLookUp` 고정 엔드포인트)로 추가하고, Google은
> 폴백으로 강등(한글 쿼리 시 `langRestrict=ko` + `country=KR`), 429는 **terminal**로 분류해
> ms 백오프 재시도 없이 즉시 다음 폴백으로 넘어간다(일일 쿼터에 재시도는 무의미+소진 가속).
> 추가로 쿼리 사다리(원문→공백 제거→앞쪽 절반 토큰)와 커널 유사도 랭킹(정규화 매칭·한국어판
> 우선)을 적용하고, 등록 시 중복 방지를 ISBN 외에 **정규화 제목+저자 겹침**으로 확장했다
> (중복 판정 시 기존 행 반환 + NULL 서지 필드만 백필). TTB 키는 로그/에러 메시지에 절대
> 싣지 않는다(reqwest 에러 미포맷 — URL 쿼리스트링 포함 위험).

### 1. 카탈로그 provider = Google Books(기본) + Open Library(폴백), 둘 다 키 불요

- `GET https://www.googleapis.com/books/v1/volumes` / `GET https://openlibrary.org/search.json`
  (+ `covers.openlibrary.org` 표지 URL). **도메인·경로는 코드 상수**, caller 입력은 검색어
  텍스트뿐이고 URL/host/path 필드는 스키마에 존재하지 않는다.
- HTTPS only · timeout 10s · bounded retry(5xx/429/네트워크=transient, 4xx=terminal,
  `retry.rs` 3회) · 응답 크기 상한 2MB · credential 미전달(익명 GET) · 로그는 상태코드+
  크기만(본문 금지).
- 등록되는 서지는 **등록 시점 스냅샷** — 이후 provider 데이터 변화가 로컬 기록을 바꾸지 않는다.
- 국내 서지 최적(알라딘 TTB/네이버 책)은 **API 키 필요**로 deferred. 도입 시 keychain 저장과
  설정 UI를 갖추고 이 ADR을 개정해 진행한다. `books.source/source_ref`가 provider 확장을 수용한다.

### 2. MCP 표면: `wr_reading_search_catalog`도 같은 Rust 경로를 재사용

캘린더 read-only outbound(ADR-0012) 선례를 따른다: 고정 provider, caller는 목적지를 정할
수 없음, 결과는 sanitized DTO(소개는 200자 preview).

### 3. 독서 도메인 로컬 write를 에이전트에 위임 (mcp-server-conventions §1.1 도메인 위임)

2026-07-23 사용자 발주("등록하고 트래킹 + MCP에도")를 위임 결정으로 기록한다. 논증:

- 전 write가 로컬 SQLite(외부 mutate 0 — INVARIANT #2 비대상), 사람 게이트는 각 MCP 호스트
  승인 UI(ADR-0012 원칙).
- write는 전부 **사실 기록/집행 대행**: 등록, 상태 전이("읽기 시작했다/다 읽었다"), 세션
  ("오늘 N쪽까지"), 인용 채록, 연간 목표(사용자 목표의 대화형 대행 — diet `set_goal` 선례).
- **delete류는 MCP 표면에 없다**(책/세션/인용 삭제 = 앱 UI confirm 전용). 세션 기록은
  `current_page`를 전진만 시키고(후퇴 불가), 과거 정정은 앱 표면의 patch로만.

## Consequences

- 신규 아웃바운드 2개(구글/오픈라이브러리)가 앱·MCP 프로세스에 추가된다 — read-only GET,
  익명이라 토큰 표면 변화 없음.
- 카탈로그 검색 실패는 수기 등록 폴백이 있어 기능 차단이 아니다(Google 0건 → OL 폴백,
  둘 다 실패 시에만 에러).
- 검증: 커널 파싱은 픽스처 테스트(네트워크 0), 표면은 스냅샷 테스트. 실 API 라이브
  스모크는 사용자.
