import "./SprintTimer.css";

import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import type { SprintConfig, Weekday } from "@/bindings";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/input";
import { WEEKDAY_SHORT_BY_CODE } from "@/lib/localeFormat";
import {
  useClearSprintConfig,
  useSetSprintConfig,
  useSprintConfig,
  useSprintStatus,
} from "@/lib/query";
import { pushMutationError } from "@/lib/query/client";
import {
  formatCountdown,
  formatCountdownLabel,
  formatSprintGoal,
  remainingSecondsUntil,
} from "@/lib/sprint";
import { useToastStore } from "@/lib/toast";

/** 에디터 요일 선택 순서(월→일). */
const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, minute) => String(minute).padStart(2, "0"));
const EDITOR_OPEN_ANIMATION_MS = 380;
const EDITOR_CLOSE_ANIMATION_MS = 340;

/**
 * 헤더 중앙 존 스프린트 미터 (P11, 2026-05-25 재설계) — 에디토리얼 1줄 라벨 + 얇은 진행 바.
 * 라벨 'SPRINT · {n일 HH:MM 남음}' + 3px 트랙(near-black 채움).
 * 미설정="SPRINT · 설정" + 점선 트랙(empty).
 * 클릭 → 같은 스프린트 슬롯을 인라인 에디터로 교체(interval_days 스테퍼 + 기준요일·시각 피커 + 저장).
 *
 * 다음 경계 SSOT = Rust `next_boundary`(직접 구현 + cargo test, DST 안전).
 * 진행도 = (intervalDays·86400 − remaining) / total — 매 1s tick으로 재계산(드리프트 없음).
 */
export function SprintTimer() {
  const configQ = useSprintConfig();
  const statusQ = useSprintStatus();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [editorState, setEditorState] = useState<"closed" | "opening" | "open" | "closing">(
    "closed",
  );

  // 1s tick — 표시 갱신용(now ms). 경계는 statusQ가 분 단위로 재조회한다.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const status = statusQ.data ?? null;
  const config = configQ.data ?? null;
  let meter: { display: ReturnType<typeof formatCountdown>; pct: number } | null = null;
  if (status && config) {
    const secs = remainingSecondsUntil(status.nextBoundary, nowMs);
    if (secs != null) {
      const display = formatCountdown(secs);
      // 진행도 = 전체 인터벌 대비 경과 비율. overdue면 100% 채움(시각 cap).
      const totalSec = Math.max(1, config.intervalDays * 86_400);
      const elapsedSec = totalSec - secs;
      const pct = display.overdue ? 1 : Math.max(0, Math.min(1, elapsedSec / totalSec));
      meter = { display, pct };
    }
  }

  const configured = !!config;
  const editorVisible = editorState !== "closed";

  const openEditor = () => {
    setEditorState((state) => (state === "closed" ? "opening" : state));
  };

  const closeEditor = () => {
    setEditorState((state) => (state === "closed" ? state : "closing"));
  };

  useEffect(() => {
    if (editorState !== "opening" && editorState !== "closing") return undefined;
    const id = window.setTimeout(
      () => setEditorState(editorState === "opening" ? "open" : "closed"),
      editorState === "opening" ? EDITOR_OPEN_ANIMATION_MS : EDITOR_CLOSE_ANIMATION_MS,
    );
    return () => window.clearTimeout(id);
  }, [editorState]);

  const handleClickOutside = useEffectEvent(() => closeEditor());
  useEffect(() => {
    if (editorState !== "open") return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      handleClickOutside();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [editorState]);

  const goalText = formatSprintGoal(config?.goal);

  const renderMeter = (extraClass = "", disabled = false) =>
    configured && meter ? (
      <button
        type="button"
        className={`sprint-meter${extraClass}`}
        title="스프린트 일정 편집"
        aria-live="polite"
        aria-label={`스프린트 ${goalText ? `${goalText}, ` : ""}${formatCountdownLabel(meter.display)} (${Math.round(meter.pct * 100)}%)`}
        disabled={disabled}
        onClick={openEditor}
      >
        <span className="sprint-meter-label">
          <span className="sprint-meter-tag">SPRINT</span>
        </span>
        {goalText && <span className="sprint-meter-goal">{goalText}</span>}
        <span className="sprint-meter-text">{formatCountdownLabel(meter.display)}</span>
        <span className="sprint-meter-bar" aria-hidden>
          <span className="sprint-meter-fill" style={{ width: `${meter.pct * 100}%` }} />
        </span>
      </button>
    ) : (
      <button
        type="button"
        className={`sprint-meter is-empty${extraClass}`}
        title="스프린트 일정 설정"
        disabled={disabled}
        onClick={openEditor}
      >
        <span className="sprint-meter-label">
          <span className="sprint-meter-tag">SPRINT</span>
        </span>
        <span className="sprint-meter-text">설정</span>
        <span className="sprint-meter-bar" aria-hidden />
      </button>
    );

  return (
    <div
      ref={rootRef}
      className={cn("sprint-timer", editorVisible && "is-editing", goalText && "has-goal")}
    >
      {/* opening: 미터는 위로 빠지고(slideOutUp), 에디터는 아래에서 올라옴(slideInUp).
       *  closing: 에디터는 아래로 사라지고(slideOutDown), 미터는 위에서 내려옴(slideInDown). */}
      {editorState === "opening" && renderMeter(" is-leaving", true)}
      {editorState === "closing" && renderMeter(" is-entering", true)}
      {editorVisible ? (
        <SprintEditor
          config={configQ.data ?? null}
          opening={editorState === "opening"}
          closing={editorState === "closing"}
          onClose={closeEditor}
        />
      ) : (
        renderMeter()
      )}
    </div>
  );
}

type EditorProps = {
  config: SprintConfig | null;
  opening?: boolean;
  closing?: boolean;
  onClose: () => void;
};

const DEFAULT_CONFIG: SprintConfig = {
  intervalDays: 14,
  anchorWeekday: "fri",
  anchorTime: "21:00",
  goal: "",
};

function SprintEditor({ config, opening = false, closing = false, onClose }: EditorProps) {
  const handleEscape = useEffectEvent(() => onClose());
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleEscape();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <form
      className={cn("sprint-inline-editor", opening && "is-opening", closing && "is-closing")}
      aria-label="스프린트 일정 편집"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="sprint-editor-title">SPRINT</div>
      <SprintEditorFields config={config} onClose={onClose} />
    </form>
  );
}

function SprintEditorFields({ config, onClose }: EditorProps) {
  const fieldId = useId();
  const intervalId = `${fieldId}-interval`;

  const setConfig = useSetSprintConfig();
  const clearConfig = useClearSprintConfig();
  const { pushSuccess } = useToastStore();

  const [intervalDays, setIntervalDays] = useState(
    config?.intervalDays ?? DEFAULT_CONFIG.intervalDays,
  );
  const [weekday, setWeekday] = useState<Weekday>(
    config?.anchorWeekday ?? DEFAULT_CONFIG.anchorWeekday,
  );
  const [time, setTime] = useState(config?.anchorTime ?? DEFAULT_CONFIG.anchorTime);
  const [goal, setGoal] = useState(config?.goal ?? DEFAULT_CONFIG.goal);
  const [hour, minute] = time.split(":");
  const setTimePart = (nextHour: string, nextMinute: string) =>
    setTime(`${nextHour}:${nextMinute}`);

  const save = () => {
    if (setConfig.isPending) return;
    setConfig.mutate(
      {
        intervalDays,
        anchorWeekday: weekday,
        anchorTime: time,
        goal: formatSprintGoal(goal) ?? "",
      },
      {
        onSuccess: () => {
          pushSuccess("스프린트 일정 저장됨 · 주간 목표 자동 동기화");
          onClose();
        },
        // 저장 실패는 조용히 삼키지 않는다 — 토스트로 표면화하고 에디터는 열어 둔다(재시도 가능).
        onError: (e) => pushMutationError("sprint", e, "스프린트 저장"),
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
      onError: (e) => pushMutationError("sprint", e, "스프린트 해제"),
    });
  };

  return (
    <div className="sprint-editor-grid">
      <label className="sprint-field" htmlFor={intervalId}>
        <span className="sprint-lbl">길이</span>
        <div className="sprint-stepper">
          <Button
            variant="outline"
            className="size-7 rounded-[var(--radius-sm)] p-0 text-base font-medium"
            onClick={() => setIntervalDays((d) => Math.max(1, d - 1))}
            aria-label="길이 감소"
          >
            −
          </Button>
          <Input
            id={intervalId}
            type="number"
            min={1}
            value={intervalDays}
            onChange={(e) => setIntervalDays(Math.max(1, Number(e.target.value) || 1))}
            className="h-7 w-14 px-1 text-center font-mono text-xs font-semibold"
          />
          <Button
            variant="outline"
            className="size-7 rounded-[var(--radius-sm)] p-0 text-base font-medium"
            onClick={() => setIntervalDays((d) => d + 1)}
            aria-label="길이 증가"
          >
            +
          </Button>
        </div>
      </label>

      <label className="sprint-field">
        <span className="sprint-lbl">요일</span>
        <div className="sprint-wd-row">
          {WEEKDAYS.map((wd) => (
            <Button
              key={wd}
              variant="outline"
              size="sm"
              className={cn(
                "flex-1 rounded-[var(--radius-sm)] px-0 text-[13px] text-[color:var(--color-wr-subtle)]",
                wd === weekday &&
                  "text-foreground border-[color:var(--color-wr-accent)] bg-[color:var(--color-wr-surface)] font-semibold",
              )}
              onClick={() => setWeekday(wd)}
              aria-pressed={wd === weekday}
            >
              {WEEKDAY_SHORT_BY_CODE[wd]}
            </Button>
          ))}
        </div>
      </label>

      <label className="sprint-field">
        <span className="sprint-lbl">시각</span>
        <div className="sprint-time-selectors">
          <select
            className="sprint-time-select"
            value={hour ?? DEFAULT_CONFIG.anchorTime.slice(0, 2)}
            onChange={(e) =>
              setTimePart(e.target.value, minute ?? DEFAULT_CONFIG.anchorTime.slice(3, 5))
            }
            aria-label="스프린트 기준 시"
          >
            {HOURS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <span className="sprint-time-sep" aria-hidden>
            :
          </span>
          <select
            className="sprint-time-select"
            value={minute ?? DEFAULT_CONFIG.anchorTime.slice(3, 5)}
            onChange={(e) =>
              setTimePart(hour ?? DEFAULT_CONFIG.anchorTime.slice(0, 2), e.target.value)
            }
            aria-label="스프린트 기준 분"
          >
            {MINUTES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      </label>

      <label className="sprint-field sprint-goal-field" htmlFor={`${fieldId}-goal`}>
        <span className="sprint-lbl">스프린트/주간 목표</span>
        <Input
          id={`${fieldId}-goal`}
          value={goal}
          maxLength={160}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="이번 스프린트 목표"
          className="h-7 min-w-0 px-2 text-xs"
        />
      </label>

      {setConfig.isError && <div className="sprint-err">{String(setConfig.error)}</div>}

      <div className="sprint-pop-actions">
        {config && (
          <Button
            variant="outline"
            className="h-7 rounded-full px-2.5 text-xs"
            onClick={remove}
            disabled={clearConfig.isPending}
          >
            해제
          </Button>
        )}
        <span className="sprint-actions-spacer" />
        <Button variant="outline" className="h-7 rounded-full px-2.5 text-xs" onClick={onClose}>
          취소
        </Button>
        <Button
          className="h-7 rounded-full px-3 text-xs"
          onClick={save}
          disabled={setConfig.isPending}
        >
          {setConfig.isPending ? "저장 중…" : "저장"}
        </Button>
      </div>
    </div>
  );
}
