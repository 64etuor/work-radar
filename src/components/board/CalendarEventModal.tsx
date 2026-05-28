import "./CalendarEventModal.css";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
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

/** YYYY-MM-DD에 n일 더해 YYYY-MM-DD 반환. 종일 이벤트의 end.date는 Google에서 **배타적**이라 +1일이 필요. */
function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

/**
 * 카드 → 직접 캘린더 이벤트 생성 모달 (Phase 19).
 * INVARIANT #2: 사용자 폼 제출 = 사람 결정 → 직접 write 정합(Acceptance 대기 없음 — 게이트는 자동화용).
 * 토큰은 keychain(Rust) — 본문 미노출. 실패는 graceful로 표시. DESIGN.md(Cohere white editorial) 톤.
 */
export function CalendarEventModal({ state, onClose }: Props) {
  const projectId = state?.projectId ?? null;
  const calendarsQ = useSelectedCalendars(projectId, !!state);
  const create = useCreateCalendarEvent();
  const { pushSuccess } = useToastStore();

  const [title, setTitle] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [calendarId, setCalendarId] = useState("");
  const [description, setDescription] = useState("");

  const calendars = useMemo(() => calendarsQ.data ?? [], [calendarsQ.data]);

  // 모달 열릴 때 폼 시드 — setState는 prev-compare로 render에서 적용 (set-state-in-effect 회피).
  const [prevState, setPrevState] = useState(state);
  if (state !== prevState) {
    setPrevState(state);
    if (state) {
      const t = defaultTimes();
      setTitle(state.title);
      setAllDay(false);
      setStart(t.start);
      setEnd(t.end);
      setDescription("");
    }
  }
  // mutation 상태 reset은 진짜 side-effect라 effect 유지.
  useEffect(() => {
    if (state) create.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // 캘린더 목록이 오면 첫 항목을 기본 선택(아직 선택 없을 때만) —
  // !calendarId 가드로 idempotent하므로 render에서 직접 적용 (set-state-in-effect 회피).
  if (calendars.length > 0 && !calendarId) {
    setCalendarId(calendars[0].id);
  }

  // Esc/외부 클릭/창 양보는 PR 0 Dialog 래퍼(overlay-stack 계약)가 전담(plan §0.6).

  if (!state) return null;

  const noCalendars = !calendarsQ.isLoading && calendars.length === 0;

  // 종일 토글 시 시작/종료 값 포맷을 맞춘다. 종일=날짜(YYYY-MM-DD), 타임드=datetime-local(00:00 기본).
  const toggleAllDay = (next: boolean) => {
    setAllDay(next);
    if (next) {
      // 종일 = 날짜(YYYY-MM-DD). end.date는 배타적이라 start 다음날 이상으로 보정(같은 날이면 +1일).
      const startDate = start.slice(0, 10);
      const endDate = end.slice(0, 10);
      setStart(startDate);
      setEnd(endDate > startDate ? endDate : addDays(startDate, 1));
    } else {
      setStart((s) => (s.length <= 10 ? `${s.slice(0, 10)}T09:00` : s));
      setEnd((s) => (s.length <= 10 ? `${s.slice(0, 10)}T10:00` : s));
    }
  };

  const submit = () => {
    if (create.isPending) return;
    const trimmed = title.trim();
    if (!trimmed || !calendarId || !start || !end) return;
    const offset = localOffset();
    // all-day = 날짜만(YYYY-MM-DD), end.date는 **배타적**이라 start보다 뒤여야 함(같거나 앞이면 +1일 보정).
    // timed = datetime-local + 로컬 오프셋 → RFC3339.
    let startVal: string;
    let endVal: string;
    if (allDay) {
      const sd = start.slice(0, 10);
      const ed = end.slice(0, 10);
      startVal = sd;
      endVal = ed > sd ? ed : addDays(sd, 1);
    } else {
      startVal = `${start}:00${offset}`;
      endVal = `${end}:00${offset}`;
    }
    create.mutate(
      {
        projectId: state.projectId as string,
        calendarId,
        event: {
          title: trimmed,
          start: startVal,
          end: endVal,
          allDay: allDay,
          description: description.trim() || null,
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
        <DialogTitle className="font-mono text-[13px] font-semibold tracking-[0.1em] uppercase">
          캘린더에 등록
        </DialogTitle>

        <label className="cev-field">
          <span className="cev-lbl">제목</span>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="이벤트 제목"
            autoFocus
          />
        </label>

        {/* 종일 토글: 행 클릭 토글(label) 접근성 유지 위해 native checkbox 보존(plan keep 정책). */}
        <label className="cev-check">
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e) => toggleAllDay(e.target.checked)}
          />
          <span>종일</span>
        </label>

        <div className="cev-row">
          <label className="cev-field">
            <span className="cev-lbl">시작</span>
            <Input
              type={allDay ? "date" : "datetime-local"}
              value={allDay ? start.slice(0, 10) : start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label className="cev-field">
            <span className="cev-lbl">종료</span>
            <Input
              type={allDay ? "date" : "datetime-local"}
              value={allDay ? end.slice(0, 10) : end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
        </div>

        <label className="cev-field">
          <span className="cev-lbl">캘린더</span>
          {noCalendars ? (
            <div className="cev-empty">
              선택된 캘린더가 없습니다 — 설정에서 Google 계정 연결 후 캘린더를 선택하세요.
            </div>
          ) : (
            <Select
              value={calendarId}
              onValueChange={setCalendarId}
              disabled={calendarsQ.isLoading}
            >
              <SelectTrigger>
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

        <label className="cev-field">
          <span className="cev-lbl">설명 (선택)</span>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="메모"
            rows={2}
          />
        </label>

        {create.isError && <div className="cev-err">{String(create.error)}</div>}

        <div className="cev-actions">
          <Button variant="outline" className="rounded-full" onClick={onClose}>
            취소
          </Button>
          <Button
            className="rounded-full px-[22px]"
            onClick={submit}
            disabled={
              create.isPending || noCalendars || !title.trim() || !calendarId || !start || !end
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
