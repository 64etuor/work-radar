import { useEffect, useId, useRef, useState } from "react";

import type { RoutineFreq, RoutineMonthlyPattern, RoutineToday, Weekday } from "@/bindings";
import {
  DAYS,
  FREQS,
  MONTHLY_PATTERNS,
  NTH_WEEKS,
  type RoutineDraft,
} from "@/components/board/routineSchedule";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";

type Props = {
  /** 수정 대상 루틴(폼 초기값). null=새 루틴 추가 모드. */
  initial: RoutineToday | null;
  /** 새 루틴 모드에서 외부 흐름(예: OKR)이 주입하는 기본값. initial 값이 항상 우선한다. */
  defaults?: {
    title?: string;
    startDate?: string | null;
    endDate?: string | null;
  };
  /** 제출 버튼 라벨 + 호출자 분기용(true=수정, false=생성). */
  isEdit: boolean;
  onSubmit: (draft: RoutineDraft) => void | Promise<void>;
  onCancel: () => void;
};

/**
 * 루틴 생성/수정 폼. 자체 입력 state(제목·빈도·요일·시간·알림·monthly 패턴·길이)를 소유한다.
 * 초기값은 `initial`에서 1회 시드 — 부모는 열 때마다 `key`를 바꿔 remount시켜 리셋/재시드한다
 * (RoutinesPanel의 openSeq). 그래서 폼 내부엔 reset 로직이 없다.
 */
export function RoutineForm({ initial, defaults, isEdit, onSubmit, onCancel }: Props) {
  const fieldId = useId();
  const timeId = `${fieldId}-time`;
  const offsetId = `${fieldId}-offset`;
  const durationId = `${fieldId}-duration`;
  const startDateId = `${fieldId}-start-date`;
  const endDateId = `${fieldId}-end-date`;
  const titleRef = useRef<HTMLInputElement | null>(null);

  const [title, setTitle] = useState(initial?.title ?? defaults?.title ?? "");
  const [freq, setFreq] = useState<RoutineFreq>(initial?.freq ?? "daily");
  const [days, setDays] = useState<Set<Weekday>>(new Set(initial?.weekdays ?? []));
  const [time, setTime] = useState(initial?.timeOfDay ?? "");
  const [offset, setOffset] = useState(
    initial?.reminderOffsetMin != null ? String(initial.reminderOffsetMin) : "",
  );
  const [monthlyPattern, setMonthlyPattern] = useState<RoutineMonthlyPattern>(
    initial?.monthlyPattern ?? "day_of_month",
  );
  const [nthWeek, setNthWeek] = useState(initial?.monthlyNthWeek ?? 2);
  const [duration, setDuration] = useState(
    initial?.durationMin != null ? String(initial.durationMin) : "",
  );
  // 활성 기간(둘 다 빈칸=무기한, 기존 동작). 'YYYY-MM-DD' or "".
  const [startDate, setStartDate] = useState(initial?.startDate ?? defaults?.startDate ?? "");
  const [endDate, setEndDate] = useState(initial?.endDate ?? defaults?.endDate ?? "");

  // 요일 입력은 weekly/biweekly(복수)에서, monthly nth_weekday(단일)에서 의미.
  const needsWeekdays = freq === "weekly" || freq === "biweekly";
  const isMonthly = freq === "monthly";
  const isNthWeekday = isMonthly && monthlyPattern === "nth_weekday";

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const toggleDay = (key: Weekday) => {
    // nth_weekday는 요일 정확히 1개 — 클릭 시 단일 선택으로 치환.
    if (isNthWeekday) {
      setDays(new Set([key]));
      return;
    }
    setDays((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    if (needsWeekdays && days.size === 0) return; // weekly/biweekly는 요일 필수.
    if (isNthWeekday && days.size !== 1) return; // nth_weekday는 요일 정확히 1개(백엔드 검증 미러).
    // weekly/biweekly는 복수 요일, nth_weekday는 단일 요일을 weekdays로 전달. 그 외는 빈 배열.
    const weekdays: Weekday[] = [];
    if (needsWeekdays || isNthWeekday) {
      for (const day of DAYS) {
        if (days.has(day.key)) weekdays.push(day.key);
      }
    }
    const offNum = offset.trim() === "" ? null : Math.max(0, Number(offset));
    const durNum = duration.trim() === "" ? null : Math.max(0, Number(duration));
    const start = startDate.trim();
    const end = endDate.trim();
    // 종료일이 시작일보다 빠르면 제출 차단(백엔드 validate_active_period 미러). 문자열 비교 = 날짜순.
    if (start !== "" && end !== "" && end < start) return;
    const draft: RoutineDraft = {
      title: t,
      freq,
      weekdays,
      // biweekly/monthly anchor는 백엔드가 기존 값 또는 오늘로 채운다(폼은 비워 보낸다).
      anchorDate: null,
      startDate: start === "" ? null : start,
      endDate: end === "" ? null : end,
      timeOfDay: time.trim() === "" ? null : time,
      reminderOffsetMin: Number.isFinite(offNum as number) ? offNum : null,
      // 패턴 필드는 monthly일 때만 의미 — 그 외 freq면 null(백엔드도 NULL 정리).
      monthlyPattern: isMonthly ? monthlyPattern : null,
      monthlyNthWeek: isNthWeekday ? nthWeek : null,
      durationMin: Number.isFinite(durNum as number) ? durNum : null,
    };
    onSubmit(draft);
  };

  return (
    <form className="rform" onSubmit={submit}>
      <Input
        ref={titleRef}
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="루틴 제목 (예: 아침 운동)"
        autoComplete="off"
        data-cb-routine-title
        className="typo-body-md mb-1.5 h-8"
      />
      <div className="rfreqs">
        {FREQS.map((f) => (
          <Button
            key={f.value}
            type="button"
            variant={freq === f.value ? "default" : "outline"}
            size="sm"
            aria-pressed={freq === f.value}
            className="flex-1 text-[11px]"
            onClick={() => setFreq(f.value)}
          >
            {f.label}
          </Button>
        ))}
      </div>
      {isMonthly && (
        <fieldset className="rfreqs m-0 min-w-0 border-0 p-0">
          <legend className="sr-only">월간 반복 방식</legend>
          {MONTHLY_PATTERNS.map((p) => (
            <Button
              key={p.value}
              type="button"
              variant={monthlyPattern === p.value ? "default" : "outline"}
              size="sm"
              aria-pressed={monthlyPattern === p.value}
              className="flex-1 text-[11px]"
              onClick={() => setMonthlyPattern(p.value)}
            >
              {p.label}
            </Button>
          ))}
        </fieldset>
      )}
      {isNthWeekday && (
        <fieldset className="days m-0 min-w-0 border-0 p-0">
          <legend className="sr-only">주차 선택</legend>
          {NTH_WEEKS.map((w) => (
            <Button
              key={w.value}
              type="button"
              variant={nthWeek === w.value ? "default" : "outline"}
              size="sm"
              aria-pressed={nthWeek === w.value}
              className="h-[26px] flex-1 p-0 text-[11px]"
              onClick={() => setNthWeek(w.value)}
            >
              {w.label}
            </Button>
          ))}
        </fieldset>
      )}
      {(needsWeekdays || isNthWeekday) && (
        <div className="days">
          {DAYS.map((d) => (
            <Button
              key={d.key}
              type="button"
              variant={days.has(d.key) ? "default" : "outline"}
              size="sm"
              aria-pressed={days.has(d.key)}
              className="size-[26px] p-0 text-[11px]"
              onClick={() => toggleDay(d.key)}
            >
              {d.label}
            </Button>
          ))}
        </div>
      )}
      {isMonthly && monthlyPattern === "day_of_month" && (
        <div className="rhint">오늘 날짜를 매월 기준일로 사용합니다 (월말 자동 보정).</div>
      )}
      {isNthWeekday && (
        <div className="rhint">매월 N번째 해당 요일에 반복합니다 (요일 하나 선택).</div>
      )}
      {freq === "biweekly" && <div className="rhint">이번 주를 기준으로 2주마다 반복합니다.</div>}
      <div className="rtime">
        <label htmlFor={timeId}>
          시간
          <Input
            id={timeId}
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="h-8 w-auto px-2 text-xs"
          />
        </label>
        <label htmlFor={offsetId}>
          알림
          <span className="roff">
            <Input
              id={offsetId}
              type="number"
              min={0}
              value={offset}
              onChange={(e) => setOffset(e.target.value)}
              placeholder="0"
              disabled={time.trim() === ""}
              className="h-8 w-12 px-2 text-xs"
            />
            분 전
          </span>
        </label>
        <label htmlFor={durationId}>
          길이
          <span className="roff">
            <Input
              id={durationId}
              type="number"
              min={0}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              placeholder="30"
              className="h-8 w-12 px-2 text-xs"
            />
            분
          </span>
        </label>
      </div>
      <div className="rtime">
        <label htmlFor={startDateId}>
          시작일
          <DatePicker
            id={startDateId}
            value={startDate || null}
            onChange={(d) => setStartDate(d ?? "")}
            max={endDate || undefined}
            placeholder="없음"
            ariaLabel="시작일"
            className="h-8 px-2 text-xs"
          />
        </label>
        <label htmlFor={endDateId}>
          종료일
          <DatePicker
            id={endDateId}
            value={endDate || null}
            onChange={(d) => setEndDate(d ?? "")}
            min={startDate || undefined}
            placeholder="없음"
            ariaLabel="종료일"
            className="h-8 px-2 text-xs"
          />
        </label>
      </div>
      <div className="rhint">기간을 비우면 무기한 반복합니다.</div>
      <div className="row">
        <Button type="submit" size="sm" className="rounded-full px-3.5 text-xs">
          {isEdit ? "저장" : "추가"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full px-3.5 text-xs"
          onClick={onCancel}
        >
          취소
        </Button>
      </div>
    </form>
  );
}
