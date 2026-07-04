/**
 * WKWebView 컴포지터 stale-paint 리싱크 — f7f0e4a(콜드마운트 +1px nudge)의 일반화 유틸.
 *
 * 증상 계열: 절대 위치 블록 레이어의 레이아웃 좌표는 정확(getBoundingClientRect/hit-test 일치)한데
 * 페인트만 세로 오프셋 — 리사이즈 핸들이 "보이는 위치 아래"에서 잡히고, 실제 스크롤(휠) 한 번이면
 * 정상화된다. WKWebView가 스크롤 컨테이너 안 absolutely-positioned 레이어를 프로그램적 변경
 * (pre-paint scrollTop 변이, 블록 배치/이동 커밋) 후 리페인트하지 않는 컴포지터 버그.
 *
 * 대책: 사용자가 휠로 고치는 것과 동일한 "실제 스크롤 델타"를 합성한다 — post-paint rAF에서
 * ±1px 이동 후 다음 rAF에서 상대 복원. 트리거별 점-수정(두더지잡기) 대신 배치-커밋/프로그램
 * 스크롤 경로 전부가 이 한 유틸을 호출한다.
 */

type ScrollMetrics = { scrollTop: number; clientHeight: number; scrollHeight: number };

/**
 * nudge 방향(±1px) — 클램프로 무효화되지 않는 쪽을 고른다.
 * 아래로 스크롤 여지가 있으면 +1, 바닥이면 -1(위로). 실제 델타가 없으면 리싱크도 없다.
 */
export function resyncNudgePx(m: ScrollMetrics): 1 | -1 {
  return m.scrollTop + m.clientHeight < m.scrollHeight - 0.5 ? 1 : -1;
}

/**
 * post-paint 더블 rAF로 scrollTop ±1px → 상대 복원. 복원이 상대(-nudge)인 이유: anchor-shift처럼
 * 사용자 스크롤 도중 호출될 수 있어 절대 복원은 프레임 사이 사용자 델타를 되감아 버린다.
 * rAF를 cleanup에서 취소하지 않는 호출 계약(StrictMode simulated unmount가 nudge를 죽이지 않게,
 * f7f0e4a와 동일) — isConnected 가드가 진짜 unmount를 걸러낸다.
 *
 * `skip`(선택)은 **rAF 발화 시점**에 평가한다 — CSSOM-View상 즉시 scrollTop 대입은 진행 중인
 * `scrollTo({behavior:"smooth"})`를 중단시키므로, 호출부가 "프로그램 스크롤 인플라이트면 건너뛴다"
 * 게이트를 걸 수 있어야 한다. 스케줄 시점 평가로는 부족: anchor-shift(useLayoutEffect)가 nudge를
 * 예약한 *뒤* 네비 passive effect가 smooth 스크롤을 시작하는 순서라 인플라이트 상태는 rAF에서만 보인다.
 */
/**
 * el의 가장 가까운 세로 스크롤 조상(콘텐츠가 클립되는 컨테이너). Today 타임라인에선 그리드의
 * `.today-canvas-wrap`. getComputedStyle 미사용(node 테스트 env 호환) — scrollHeight>clientHeight+1
 * 휴리스틱이면 충분하다(비클립 조상은 두 값이 일치, +1은 라운딩 여유). 단 오탐(비스크롤 조상 매칭)은
 * 진짜 스크롤러를 가려 리싱크가 조용히 죽는다 — 그리드와 스크롤러 사이에 고정 높이 컨테이너를
 * 끼우게 되면 이 휴리스틱에 overflowY 검사를 추가할 것.
 */
export function nearestScrollParent(el: HTMLElement | null | undefined): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight + 1) return p;
  }
  return null;
}

/**
 * 배치/이동/리사이즈 커밋 프라미스 전후로 리싱크 2회 — 첫 호출은 동기 옵티미스틱 패치 페인트를,
 * 둘째는 calendar-picker/IPC 완료 후 재렌더를 커버한다(stale-paint면 리사이즈 핸들이 "보이는 위치
 * 아래"에서 잡히는 그 버그). nudge는 ±1px 상대 복원이라 중복 호출 무해. el은 게터 — 커밋이
 * 오래 걸려도(picker 대기) 그 시점의 라이브 스크롤러를 읽는다.
 */
export async function resyncCompositorAroundCommit(
  el: () => HTMLElement | null | undefined,
  commit: Promise<unknown>,
): Promise<void> {
  scheduleCompositorResync(el());
  await commit;
  scheduleCompositorResync(el());
}

export function scheduleCompositorResync(
  el: HTMLElement | null | undefined,
  skip?: () => boolean,
): void {
  if (!el) return;
  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    if (skip?.()) return;
    const nudge = resyncNudgePx(el);
    el.scrollTop += nudge;
    requestAnimationFrame(() => {
      if (el.isConnected) el.scrollTop -= nudge;
    });
  });
}
