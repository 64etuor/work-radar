import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { addDays, dayDiff } from "@/lib/timeAxis";
import { DAY_PX } from "@/lib/timelineAxis";
import { extendDates, includeDate } from "@/lib/timelineWindow";

/** 로드 일수 상한 — DOM/메모리 바운드(스펙 §3의 윈도잉 의도를 캡으로 충족). */
const MAX_LOADED_DAYS = 21;

type UseTimelineScrollArgs = {
  today: string;
  gridElRef: RefObject<HTMLDivElement | null>;
};

export function useTimelineScroll({ today, gridElRef }: UseTimelineScrollArgs) {
  // 레일/트레이/KPI 스코프 날짜(기존 의미 유지). 타임라인은 visibleDates 연속 축.
  const [date, setDate] = useState<string>(today);
  // 연속 타임라인의 로드된 날짜들(연속·오름차순, 스펙 §3). 초기 [어제, 오늘, 내일].
  const [visibleDates, setVisibleDates] = useState<string[]>(() => [
    addDays(today, -1),
    today,
    addDays(today, 1),
  ]);
  const anchorDate = visibleDates[0];

  // ── 연속 스크롤 관리(스펙 §3·§4) ─────────────────────────────────────
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const prevAnchorRef = useRef(anchorDate);
  const didInitialScrollRef = useRef(false);
  const extendingRef = useRef(false);
  const prevNavDateRef = useRef(date);
  /**
   * 프로그램 스크롤(네비/"오늘" 클릭) 중 표시 — smooth 애니메이션이 끝날 때까지
   * 스크롤 추종(setDate)·lazy-extend를 억제한다. 추종을 끄지 않으면 중간 날짜들로
   * date가 깜빡이고, extend의 prepend 보정이 애니메이션 목표 좌표를 흔든다.
   * 해제 = 목표 근접(8px) 또는 1.6s 타임아웃(사용자 휠 개입 등으로 미도달 시 fail-open).
   */
  const programmaticScrollRef = useRef<{ target: number; since: number } | null>(null);
  const followRafRef = useRef<number | null>(null);

  // 초기 1회: "지금"이 뷰포트 중앙에 오도록(스펙 §1 — 열면 현재시각 센터).
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || didInitialScrollRef.current) return;
    const idx = visibleDates.indexOf(today);
    if (idx < 0) return;
    const now = new Date();
    const nowPx = idx * DAY_PX + now.getHours() * 60 + now.getMinutes();
    const target = Math.max(0, nowPx - el.clientHeight / 2);
    el.scrollTop = target;
    didInitialScrollRef.current = true;
    // WKWebView 콜드마운트 stale-paint 수정: pre-paint 프로그램 스크롤이 절대 위치 블록 레이어를
    // stale하게 페인트한다(좌표는 정확, 화면만 아래로 오프셋; 휠로 굴리면 정상화). post-paint(rAF)에서
    // 실제 스크롤 델타(+1px→복귀)로 컴포지터를 리싱크. cleanup 미취소 = StrictMode가 nudge를 죽이지 않게.
    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      el.scrollTop = target + 1;
      requestAnimationFrame(() => {
        if (el.isConnected) el.scrollTop = target;
      });
    });
  }, [visibleDates, today]);

  // prepend(또는 상단 드롭) 시 scrollTop 보정 — anchor 변화량(일수×1440px)만큼.
  // 빼먹으면 위로 날짜를 붙일 때 화면이 점프한다(스펙 §3 prepend 앵커링).
  // 같은 커밋에서 now 라인(`top 60s`)·블록 wrap의 절대 top도 +1440px 점프하므로, 페인트 전에
  // 그리드에 data-anchor-shift를 걸어 CSS 트랜지션을 한 프레임 끈다 — 안 끄면 scrollTop은
  // 보정돼 화면이 고정인데 선/블록이 트랜지션을 따라 천천히 아래로 흘러내린다.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    const prev = prevAnchorRef.current;
    prevAnchorRef.current = anchorDate;
    if (!el || prev === anchorDate) return;
    el.scrollTop += dayDiff(prev, anchorDate) * DAY_PX;
    const grid = gridElRef.current;
    if (grid) {
      grid.setAttribute("data-anchor-shift", "");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => grid.removeAttribute("data-anchor-shift"));
      });
    }
  }, [anchorDate, gridElRef]);

  // 날짜 목록 갱신 반영 후 lazy-extend 가드 해제.
  useEffect(() => {
    extendingRef.current = false;
  }, [visibleDates]);

  const smoothScrollTo = useCallback((top: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, top));
    programmaticScrollRef.current = { target: clamped, since: performance.now() };
    el.scrollTo({ top: clamped, behavior: "smooth" });
  }, []);

  const handleCanvasScroll = () => {
    const el = wrapRef.current;
    if (!el) return;

    // 프로그램 스크롤 진행 중 — 도달/타임아웃 전엔 추종·extend 모두 보류.
    const prog = programmaticScrollRef.current;
    if (prog) {
      const arrived = Math.abs(el.scrollTop - prog.target) < 8;
      const timedOut = performance.now() - prog.since > 1_600;
      if (!arrived && !timedOut) return;
      programmaticScrollRef.current = null;
    }

    // 스크롤 추종: 뷰포트 중앙이 속한 날짜로 헤더 date를 따라가게(rAF 1회로 합침).
    // 추종발 setDate는 네비가 아니므로 prevNavDateRef를 같이 맞춰 스크롤-투-날짜 effect를 무효화.
    if (followRafRef.current === null) {
      followRafRef.current = requestAnimationFrame(() => {
        followRafRef.current = null;
        const node = wrapRef.current;
        if (!node || programmaticScrollRef.current) return;
        const centerIdx = Math.floor((node.scrollTop + node.clientHeight / 2) / DAY_PX);
        const clampedIdx = Math.max(0, Math.min(visibleDates.length - 1, centerIdx));
        const viewDate = visibleDates[clampedIdx];
        if (viewDate && viewDate !== prevNavDateRef.current) {
          prevNavDateRef.current = viewDate;
          setDate(viewDate);
        }
      });
    }

    if (extendingRef.current) return;
    // 캡 도달 시 lazy-extend 자체를 멈춘다(가드 ref를 세우지 않음 — no-op setState 방지).
    if (visibleDates.length >= MAX_LOADED_DAYS) return;
    const nearTop = el.scrollTop < DAY_PX / 2;
    const nearBottom = el.scrollTop + el.clientHeight > el.scrollHeight - DAY_PX / 2;
    if (!nearTop && !nearBottom) return;
    extendingRef.current = true;
    // 캡 = 확장 중단(축출 아님) — today/date가 visibleDates에서 절대 빠지지 않아
    // now 라인 소실·레일↔캔버스 버킷 불일치가 구조적으로 불가능(timelineWindow.ts).
    setVisibleDates((prev) => extendDates(prev, nearTop ? "up" : "down", MAX_LOADED_DAYS));
  };

  // 추종 rAF 잔여분 unmount 정리.
  useEffect(
    () => () => {
      if (followRafRef.current !== null) cancelAnimationFrame(followRafRef.current);
    },
    [],
  );

  // 헤더 날짜 네비 — 레일 스코프 변경 + 타임라인을 그 날짜로 스크롤(범위 밖이면 로드 확장).
  const handleDateChange = (d: string) => {
    setDate(d);
    setVisibleDates((prev) => includeDate(prev, d));
  };

  // 네비로 date가 바뀐 뒤(같은 렌더 사이클에 visibleDates 확장 반영됨) 해당 날짜로 smooth 스크롤.
  // 목적지는 모든 날짜("오늘" 포함) 08:00 상단 — 업무시간 시작이 화면에 들어오게(사용자 피드백:
  // 현재시각 센터는 오후에 누르면 13시부터 보여 아침 일정이 가려진다).
  // 스크롤-추종발 변경은 prevNavDateRef가 이미 갱신돼 있어 여기서 스킵된다.
  useEffect(() => {
    if (prevNavDateRef.current === date) return;
    prevNavDateRef.current = date;
    const idx = dayDiff(date, anchorDate);
    if (idx < 0 || idx >= visibleDates.length) return;
    smoothScrollTo(idx * DAY_PX + 8 * 60);
  }, [date, anchorDate, visibleDates.length, smoothScrollTo]);

  return {
    anchorDate,
    date,
    handleCanvasScroll,
    handleDateChange,
    visibleDates,
    wrapRef,
  };
}
