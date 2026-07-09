import "./CalendarEventModal.css";

import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { addDays } from "@/lib/calendarRange";
import { localToday, useCreateCalendarEvent, useSelectedCalendars } from "@/lib/query";
import { useToastStore } from "@/lib/toast";

/** 모달이 다룰 카드 컨텍스트(제목 prefill + 어느 프로젝트의 캘린더를 쓸지). */
export type CalendarModalState = {
  signalId: string;
  title: string;
  projectId: string | null;
};

type Props = {
  state: CalendarModalState | null;
  onClose: () => void;
};

type CalendarDraft = {
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  calendarId: string;
  description: string;
};

/** "HH:00" 한 시간 뒤를 더한 RFC3339 보정 없이 datetime-local 값(YYYY-MM-DDTHH:mm) 두 개를 만든다. */
function defaultTimes(): { start: string; end: string } {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const start = new Date(now.getTime() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const fmt = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  return { start: fmt(start), end: fmt(end) };
}

/** 로컬 UTC 오프셋("+09:00") — datetime-local(오프셋 없음)을 RFC3339로 만들 때 붙인다. */
function localOffset(): string {
  const min = -new Date().getTimezoneOffset();
  const sign = min >= 0 ? "+" : "-";
  const abs = Math.abs(min);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function createDraft(title: string): CalendarDraft {
  const t = defaultTimes();
  return {
    title,
    allDay: false,
    start: t.start,
    end: t.end,
    calendarId: "",
    description: "",
  };
}

/**
 * 카드 → 직접 캘린더 이벤트 생성 모달 (Phase 19).
 * INVARIANT #2: 사용자 폼 제출 = 사람 결정 → 직접 write 정합(Acceptance 대기 없음 — 게이트는 자동화용).
 * 토큰은 keychain(Rust) — 본문 미노출. 실패는 graceful로 표시. DESIGN.md(Cohere white editorial) 톤.
 */
export function CalendarEventModal({ state, onClose }: Props) {
  if (!state) return null;

  return <CalendarEventModalContent key={state.signalId} state={state} onClose={onClose} />;
}

function CalendarEventModalContent({
  state,
  onClose,
}: {
  state: CalendarModalState;
  onClose: () => void;
}) {
  const fieldId = useId();
  const titleId = `${fieldId}-title`;
  const startId = `${fieldId}-start`;
  const endId = `${fieldId}-end`;
  const calendarFieldId = `${fieldId}-calendar`;
  const descId = `${fieldId}-desc`;

  const projectId = state.projectId;
  const calendarsQ = useSelectedCalendars(projectId, true);
  const create = useCreateCalendarEvent();
  const { pushSuccess } = useToastStore();

  const [draft, setDraft] = useState(() => createDraft(state.title));

  const calendars = calendarsQ.data ?? [];
  const calendarId = draft.calendarId || calendars[0]?.id || "";

  const { reset } = create;
  useEffect(() => {
    reset();
  }, [reset]);

  // Esc/외부 클릭/창 양보는 PR 0 Dialog 래퍼(overlay-stack 계약)가 전담(plan §0.6).

  const noCalendars = !calendarsQ.isLoading && calendars.length === 0;

  // 종일 토글 시 시작/종료 값 포맷을 맞춘다. 종일=날짜(YYYY-MM-DD), 타임드=datetime-local(00:00 기본).
  const toggleAllDay = (next: boolean) => {
    const start = draft.start;
    const end = draft.end;
    if (next) {
      // 종일 = 날짜(YYYY-MM-DD). end.date는 배타적이라 start 다음날 이상으로 보정(같은 날이면 +1일).
      const startDate = start.slice(0, 10);
      const endDate = end.slice(0, 10);
      setDraft((current) => ({
        ...current,
        allDay: true,
        start: startDate,
        end: endDate > startDate ? endDate : addDays(startDate, 1),
      }));
    } else {
      setDraft((current) => ({
        ...current,
        allDay: false,
        start: current.start.length <= 10 ? `${current.start.slice(0, 10)}T09:00` : current.start,
        end: current.end.length <= 10 ? `${current.end.slice(0, 10)}T10:00` : current.end,
      }));
    }
  };

  const submit = () => {
    if (create.isPending) return;
    const trimmed = draft.title.trim();
    if (!trimmed || !calendarId || !draft.start || !draft.end) return;
    const offset = localOffset();
    // all-day = 날짜만(YYYY-MM-DD), end.date는 **배타적**이라 start보다 뒤여야 함(같거나 앞이면 +1일 보정).
    // timed = datetime-local + 로컬 오프셋 → RFC3339.
    let startVal: string;
    let endVal: string;
    if (draft.allDay) {
      const sd = draft.start.slice(0, 10);
      const ed = draft.end.slice(0, 10);
      startVal = sd;
      endVal = ed > sd ? ed : addDays(sd, 1);
    } else {
      startVal = `${draft.start}:00${offset}`;
      endVal = `${draft.end}:00${offset}`;
    }
    create.mutate(
      {
        projectId: state.projectId as string,
        calendarId,
        event: {
          title: trimmed,
          start: startVal,
          end: endVal,
          allDay: draft.allDay,
          description: draft.description.trim() || null,
        },
      },
      {
        onSuccess: (out) => {
          pushSuccess(
            "캘린더에 등록됨",
            out.url ? { actionUrl: out.url, actionLabel: "열기" } : undefined,
          );
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        showClose={false}
        aria-describedby={undefined}
        className="max-h-[78vh] w-[min(440px,92vw)] max-w-none gap-3 overflow-y-auto p-5"
      >
        <DialogTitle className="typo-mono-heading">캘린더에 등록</DialogTitle>

        <label className="cev-field" htmlFor={titleId}>
          <span className="cev-lbl">제목</span>
          <Input
            id={titleId}
            value={draft.title}
            onChange={(e) => setDraft((current) => ({ ...current, title: e.target.value }))}
            placeholder="이벤트 제목"
            autoFocus
          />
        </label>

        {/* 종일 토글: 행 클릭 토글(label) 접근성 유지 위해 native checkbox 보존(plan keep 정책). */}
        <label className="cev-check">
          <input
            type="checkbox"
            aria-label="종일"
            checked={draft.allDay}
            onChange={(e) => toggleAllDay(e.target.checked)}
          />
          <span>종일</span>
        </label>

        <div className="cev-row">
          <label className="cev-field" htmlFor={startId}>
            <span className="cev-lbl">시작</span>
            <Input
              id={startId}
              type={draft.allDay ? "date" : "datetime-local"}
              value={draft.allDay ? draft.start.slice(0, 10) : draft.start}
              onChange={(e) => setDraft((current) => ({ ...current, start: e.target.value }))}
            />
          </label>
          <label className="cev-field" htmlFor={endId}>
            <span className="cev-lbl">종료</span>
            <Input
              id={endId}
              type={draft.allDay ? "date" : "datetime-local"}
              value={draft.allDay ? draft.end.slice(0, 10) : draft.end}
              onChange={(e) => setDraft((current) => ({ ...current, end: e.target.value }))}
            />
          </label>
        </div>

        <label className="cev-field" htmlFor={calendarFieldId}>
          <span className="cev-lbl">캘린더</span>
          {noCalendars ? (
            <EmptyState className="cev-empty">
              선택된 캘린더가 없습니다. 설정에서 Google 계정 연결 후 캘린더를 선택하세요.
            </EmptyState>
          ) : (
            <Select
              value={calendarId}
              onValueChange={(next) => setDraft((current) => ({ ...current, calendarId: next }))}
              disabled={calendarsQ.isLoading}
            >
              <SelectTrigger id={calendarFieldId} aria-label="캘린더 선택">
                <SelectValue placeholder="캘린더 선택" />
              </SelectTrigger>
              <SelectContent>
                {calendars.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.summary}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </label>

        <label className="cev-field" htmlFor={descId}>
          <span className="cev-lbl">설명 (선택)</span>
          <Textarea
            id={descId}
            value={draft.description}
            onChange={(e) => setDraft((current) => ({ ...current, description: e.target.value }))}
            placeholder="메모"
            rows={2}
          />
        </label>

        {create.isError && <div className="cev-err">{String(create.error)}</div>}

        <div className="cev-actions">
          <Button variant="outline" size="pill" onClick={onClose}>
            취소
          </Button>
          <Button
            size="pill"
            onClick={submit}
            disabled={
              create.isPending ||
              noCalendars ||
              !draft.title.trim() ||
              !calendarId ||
              !draft.start ||
              !draft.end
            }
            title={projectId ? "Google Calendar에 이벤트 생성" : "프로젝트 미태깅 카드"}
          >
            {create.isPending ? "등록 중…" : "등록"}
          </Button>
        </div>
        {!projectId && (
          <div className="cev-hint">
            이 카드는 프로젝트에 태깅되어 있지 않아 캘린더를 찾을 수 없습니다. 먼저 프로젝트를
            연결하세요.
          </div>
        )}
        <div className="cev-hint">
          오늘: {localToday()} · 폼 제출이 곧 등록입니다(승인 대기 없음).
        </div>
      </DialogContent>
    </Dialog>
  );
}
