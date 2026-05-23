import { useEffect, useMemo, useRef, useState } from "react";

import type { SprintConfig, Weekday } from "@/bindings";
import {
  useClearSprintConfig,
  useSetSprintConfig,
  useSprintConfig,
  useSprintStatus,
} from "@/lib/query";
import {
  formatCountdown,
  remainingSecondsUntil,
  WEEKDAY_LABELS,
} from "@/lib/sprint";
import { useToastStore } from "@/lib/toast";

/** 에디터 요일 선택 순서(월→일). */
const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/**
 * 브랜드 헤더 우측 존 스프린트 카운트다운 (P11) — DESIGN.md `sprint-timer` 정본.
 * 에이전트 바와 **분리**된 헤더 우측 존. 'D일 HH:MM' CohereMono, **1s tick**,
 * overdue=Coral + '지남' 라벨(색+라벨 병기). 미설정 시 "스프린트 설정" 텍스트 링크(empty).
 * 클릭 → 팝오버 에디터(interval_days 스테퍼 + 기준요일·시각 피커 + 저장).
 *
 * 다음 경계 계산 SSOT = Rust `next_boundary`(직접 구현 + cargo test, rrule 미사용, DST 안전).
 * 프런트는 받은 경계 RFC3339로 로컬 1s tick 표시만 한다(drift 없음 — 경계는 anchor+interval로 매번 산출).
 */
export function SprintTimer() {
  const configQ = useSprintConfig();
  const statusQ = useSprintStatus();
  const [open, setOpen] = useState(false);

  // 1s tick — 표시 갱신용(now ms). 경계는 statusQ가 분 단위로 재조회한다.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const status = statusQ.data ?? null;
  const display = useMemo(() => {
    if (!status) return null;
    const secs = remainingSecondsUntil(status.nextBoundary, nowMs);
    if (secs == null) return null;
    return formatCountdown(secs);
  }, [status, nowMs]);

  const configured = !!configQ.data;

  return (
    <div className="sprint-timer">
      {configured && display ? (
        <button
          type="button"
          className={`sprint-count${display.overdue ? " is-overdue" : ""}`}
          onClick={() => setOpen(true)}
          title="스프린트 일정 편집"
          aria-live="polite"
        >
          <span className="sprint-count-text">
            <span className="sprint-count-full">{display.text}</span>
            <span className="sprint-count-compact">{display.compact}</span>
          </span>
          {display.overdue && <span className="sprint-overdue-lbl">지남</span>}
        </button>
      ) : (
        <button
          type="button"
          className="sprint-empty-link"
          onClick={() => setOpen(true)}
        >
          스프린트 설정
        </button>
      )}

      {open && (
        <SprintEditor
          config={configQ.data ?? null}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

type EditorProps = {
  config: SprintConfig | null;
  onClose: () => void;
};

const DEFAULT_CONFIG: SprintConfig = {
  intervalDays: 14,
  anchorWeekday: "fri",
  anchorTime: "21:00",
};

/** 팝오버 에디터: interval_days 스테퍼 + 기준요일·시각 피커 + 저장(흰 카드 radius lg). */
function SprintEditor({ config, onClose }: EditorProps) {
  const setConfig = useSetSprintConfig();
  const clearConfig = useClearSprintConfig();
  const { pushSuccess } = useToastStore();

  const [intervalDays, setIntervalDays] = useState(
    config?.intervalDays ?? DEFAULT_CONFIG.intervalDays,
  );
  const [weekday, setWeekday] = useState<Weekday>(
    config?.anchorWeekday ?? DEFAULT_CONFIG.anchorWeekday,
  );
  const [time, setTime] = useState(
    config?.anchorTime ?? DEFAULT_CONFIG.anchorTime,
  );

  const cardRef = useRef<HTMLDivElement>(null);

  // ESC / 외부 클릭으로 닫기.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const save = () => {
    if (setConfig.isPending) return;
    setConfig.mutate(
      { intervalDays, anchorWeekday: weekday, anchorTime: time },
      {
        onSuccess: () => {
          pushSuccess("스프린트 일정 저장됨");
          onClose();
        },
      },
    );
  };

  const remove = () => {
    if (clearConfig.isPending) return;
    clearConfig.mutate(undefined, {
      onSuccess: () => {
        pushSuccess("스프린트 해제됨");
        onClose();
      },
    });
  };

  return (
    <div className="sprint-pop-overlay" onPointerDown={onClose}>
      <div
        className="sprint-pop"
        role="dialog"
        aria-label="스프린트 일정 편집"
        ref={cardRef}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="sprint-pop-head">스프린트 일정</div>

        <label className="sprint-field">
          <span className="sprint-lbl">길이 (일)</span>
          <div className="sprint-stepper">
            <button
              type="button"
              className="sprint-step-btn"
              onClick={() => setIntervalDays((d) => Math.max(1, d - 1))}
              aria-label="길이 감소"
            >
              −
            </button>
            <input
              className="sprint-step-val"
              type="number"
              min={1}
              value={intervalDays}
              onChange={(e) =>
                setIntervalDays(Math.max(1, Number(e.target.value) || 1))
              }
            />
            <button
              type="button"
              className="sprint-step-btn"
              onClick={() => setIntervalDays((d) => d + 1)}
              aria-label="길이 증가"
            >
              +
            </button>
          </div>
        </label>

        <label className="sprint-field">
          <span className="sprint-lbl">기준 요일</span>
          <div className="sprint-wd-row">
            {WEEKDAYS.map((wd) => (
              <button
                key={wd}
                type="button"
                className={`sprint-wd${wd === weekday ? " is-on" : ""}`}
                onClick={() => setWeekday(wd)}
                aria-pressed={wd === weekday}
              >
                {WEEKDAY_LABELS[wd]}
              </button>
            ))}
          </div>
        </label>

        <label className="sprint-field">
          <span className="sprint-lbl">기준 시각</span>
          <input
            className="sprint-time"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </label>

        {setConfig.isError && (
          <div className="sprint-err">{String(setConfig.error)}</div>
        )}

        <div className="sprint-pop-actions">
          {config && (
            <button
              type="button"
              className="sprint-btn-ghost"
              onClick={remove}
              disabled={clearConfig.isPending}
            >
              해제
            </button>
          )}
          <span className="sprint-actions-spacer" />
          <button type="button" className="sprint-btn-ghost" onClick={onClose}>
            취소
          </button>
          <button
            type="button"
            className="sprint-btn"
            onClick={save}
            disabled={setConfig.isPending}
          >
            {setConfig.isPending ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}
