import { useEffect, useMemo, useState } from "react";
import "./CalendarDrawer.css";

import { CalendarView } from "@/components/board/CalendarView";
import { type CalendarViewMode, parseLocalISODate, stepDate, viewRange } from "@/lib/calendarRange";
import {
  fetchCalendarEventsRange,
  localToday,
  useCalendarEventsRange,
  useProjects,
} from "@/lib/query";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useUIStore } from "@/store";

type Props = {
  open: boolean;
  onClose: () => void;
};

const MODE_LABEL: Record<CalendarViewMode, string> = {
  day: "일",
  week: "주",
  month: "월",
};

/** 헤더 날짜 라벨(뷰별). day=M/D(요일), week=M/D–M/D, month=YYYY.MM. */
function headerLabel(mode: CalendarViewMode, date: string): string {
  const d = parseLocalISODate(date);
  if (mode === "month") {
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  if (mode === "week") {
    const { start, end } = viewRange("week", date);
    const s = parseLocalISODate(start);
    const e = parseLocalISODate(end);
    return `${s.getMonth() + 1}/${s.getDate()} – ${e.getMonth() + 1}/${e.getDate()}`;
  }
  const dow = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()} (${dow})`;
}

/**
 * P7 캡처보드 우측 슬라이드 캘린더 드로어(조회 전용 — 일정 생성/편집 없음, 기존 등록 모달과 분리).
 * 일/주/월 전환 + < 오늘 > 날짜 네비. 범위 fetch는 단일 Google range 호출(주/월도 N콜 아님). 시각은
 * DESIGN.md calendar-drawer(흰 패널, 좌측 hairline, 일/주/월 본문, 상태 매트릭스). ≥1040px=우측 드로어,
 * <720px=하단 시트(CSS). 닫기=ESC/백드롭/✕. ambient 표시(결정 레일 무관 — INVARIANT #1 영향 0).
 */
export function CalendarDrawer({ open, onClose }: Props) {
  const [mode, setMode] = useState<CalendarViewMode>("day");
  const [date, setDate] = useState<string>(localToday());
  const qc = useQueryClient();
  const projectsQ = useProjects();
  const { goTo } = useUIStore();

  const { start, end } = useMemo(() => viewRange(mode, date), [mode, date]);
  const eventsQ = useCalendarEventsRange(start, end, open);

  // 어떤 프로젝트도 캘린더를 선택하지 않았으면 OAuth 미연결/미설정 상태(ambient 판정 — 네트워크 없음).
  const projects = projectsQ.data ?? [];
  const noCalendarsConfigured =
    !projectsQ.isLoading &&
    projects.length > 0 &&
    projects.every((p) => {
      const ids = p.googleCalendarIds?.trim();
      return !ids || ids === "[]";
    });

  // ESC로 닫기 + 트리거(캘린더 열기 버튼) 포커스 복원.
  // capture-phase + stopPropagation: App 셸의 bubble Esc→window.hide()보다 먼저 가로채 창 숨김을 막는다
  // (plan §0.6 — radix Dialog로 바꾸지 않고 bespoke 드로어가 직접 계약 인코딩). 닫힐 때 열기 직전
  // 포커스(트리거)를 복원해 모달/메뉴 슬라이스 hard gate (c)를 만족(원래 없던 동작 — focus body 누수 방지).
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      trigger?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const events = eventsQ.data ?? [];

  // 수동 새로고침: force=true로 Rust TTL 캐시 우회 → fresh Google fetch 후 RQ 캐시 갱신.
  const refresh = async () => {
    const fresh = await fetchCalendarEventsRange(null, start, end, true);
    qc.setQueryData(["calendarEvents", "range", start, end], fresh);
  };

  return (
    // 백드롭 없음(비모달) — 캘린더를 보면서 보드/브레인덤프를 그대로 조작할 수 있다. 닫기=✕/Esc.
    <aside className="caldrawer" role="dialog" aria-label="캘린더">
      <header className="caldrawer-head">
        <span className="caldrawer-mark">CALENDAR</span>
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(v) => v && setMode(v as CalendarViewMode)}
          className="border-wr-border-light overflow-hidden rounded-full border"
        >
          {(["day", "week", "month"] as CalendarViewMode[]).map((m) => (
            <ToggleGroupItem
              key={m}
              value={m}
              size="sm"
              className="text-wr-subtle data-[state=on]:bg-wr-accent-soft data-[state=on]:text-wr-accent font-semibold"
            >
              {MODE_LABEL[m]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <button type="button" className="caldrawer-close" aria-label="닫기" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="caldrawer-nav">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="size-7 p-0 text-[15px]"
          aria-label="이전"
          onClick={() => setDate((d) => stepDate(mode, d, -1))}
        >
          ‹
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-[13px] font-semibold"
          onClick={() => setDate(localToday())}
        >
          {headerLabel(mode, date)}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="size-7 p-0 text-[15px]"
          aria-label="다음"
          onClick={() => setDate((d) => stepDate(mode, d, 1))}
        >
          ›
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto size-7 p-0 text-[15px]"
          aria-label="새로고침"
          title="새로고침 (캐시 우회)"
          onClick={() => void refresh()}
          disabled={eventsQ.isFetching}
        >
          ⟳
        </Button>
      </div>

      <div className="caldrawer-body">
        {noCalendarsConfigured ? (
          <div className="caldrawer-state">
            <p className="caldrawer-state-msg">Google 계정이 연결되지 않았습니다.</p>
            <Button
              type="button"
              className="rounded-full px-[18px] text-[13px]"
              onClick={() => {
                onClose();
                goTo("settings");
              }}
            >
              Google 계정 연결
            </Button>
          </div>
        ) : eventsQ.isLoading ? (
          <div className="caldrawer-skeleton">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="caldrawer-skel-row" />
            ))}
          </div>
        ) : eventsQ.isError ? (
          <div className="caldrawer-state">
            <p className="caldrawer-state-msg">
              일정을 불러오지 못했습니다 — {String(eventsQ.error)}
            </p>
            <Button
              type="button"
              className="rounded-full px-[18px] text-[13px]"
              onClick={() => void eventsQ.refetch()}
            >
              재시도
            </Button>
          </div>
        ) : (
          <CalendarView
            events={events}
            mode={mode}
            date={date}
            onSelectDate={(d) => {
              setDate(d);
              setMode("day");
            }}
          />
        )}
      </div>
    </aside>
  );
}
