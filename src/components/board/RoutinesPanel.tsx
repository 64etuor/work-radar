import { useState } from "react";

import type { RoutineToday, Weekday } from "@/bindings";
import { CheckIcon } from "@/components/board/CheckIcon";

type Props = {
  routines: RoutineToday[];
  onToggle: (routineId: string, done: boolean) => void;
  onCreate: (title: string, daily: boolean, weekdays: Weekday[]) => void;
};

const DAYS: { label: string; key: Weekday }[] = [
  { label: "월", key: "mon" },
  { label: "화", key: "tue" },
  { label: "수", key: "wed" },
  { label: "목", key: "thu" },
  { label: "금", key: "fri" },
  { label: "토", key: "sat" },
  { label: "일", key: "sun" },
];

function schedLabel(r: RoutineToday): string {
  if (r.freq === "daily") return "매일";
  const order = DAYS.map((d) => d.key);
  return r.weekdays
    .slice()
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((w) => DAYS.find((d) => d.key === w)?.label ?? w)
    .join("·");
}

/** 우측 하단 Routines 패널 — 오늘 해당 반복 작업 체크리스트 + 추가 폼. */
export function RoutinesPanel({ routines, onToggle, onCreate }: Props) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [daily, setDaily] = useState(true);
  const [days, setDays] = useState<Set<Weekday>>(new Set());

  const toggleDay = (key: Weekday) => {
    setDays((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else {
        next.add(key);
        setDaily(false);
      }
      return next;
    });
  };

  const onDailyChange = (checked: boolean) => {
    setDaily(checked);
    if (checked) setDays(new Set());
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    const useDaily = daily || days.size === 0;
    const weekdays = useDaily ? [] : DAYS.filter((d) => days.has(d.key)).map((d) => d.key);
    onCreate(t, useDaily, weekdays);
    setTitle("");
    setDays(new Set());
    setDaily(true);
    setOpen(false);
  };

  return (
    <div className="panelbox">
      <div className="pb-head">
        <span className="lbl">Routines</span>
        <button
          type="button"
          className="add"
          onClick={() => setOpen((o) => !o)}
        >
          + 루틴
        </button>
      </div>

      {open && (
        <form className="rform" onSubmit={submit}>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="루틴 제목 (예: 아침 운동)"
            autoComplete="off"
            data-cb-routine-title
            autoFocus
          />
          <div className="days">
            {DAYS.map((d) => (
              <button
                key={d.key}
                type="button"
                className={`day${days.has(d.key) ? " on" : ""}`}
                onClick={() => toggleDay(d.key)}
              >
                {d.label}
              </button>
            ))}
          </div>
          <div className="row">
            <label className="daily">
              <input
                type="checkbox"
                checked={daily}
                onChange={(e) => onDailyChange(e.target.checked)}
              />{" "}
              매일
            </label>
            <button type="submit" className="save">
              추가
            </button>
          </div>
        </form>
      )}

      <div className="pb-body">
        {routines.length === 0 ? (
          <div className="empty">오늘 해당하는 루틴이 없습니다 — + 루틴으로 추가</div>
        ) : (
          routines.map((r) => (
            <div key={r.id} className={`item${r.done ? " done" : ""}`}>
              <div
                className="cb-check"
                role="checkbox"
                aria-checked={r.done}
                onClick={() => onToggle(r.id, !r.done)}
              >
                <CheckIcon />
              </div>
              <div className="body">
                <div className="ttl">{r.title}</div>
                <div className="meta">
                  <span className="badge b-sched">{schedLabel(r)}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
