import { useEffect, useMemo, useState } from "react";

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
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/components/ui/cn";

/** 에디터 요일 선택 순서(월→일). */
const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/**
 * 브랜드 헤더 우측 존 스프린트 카운트다운 (P11) — DESIGN.md `sprint-timer` 정본.
 * 에이전트 바와 **분리**된 헤더 우측 존. 'D일 HH:MM' CohereMono, **1s tick**,
 * overdue=Coral + '지남' 라벨(색+라벨 병기). 미설정 시 "스프린트 설정" 텍스트 링크(empty).
 * 클릭 → Dialog 에디터(interval_days 스테퍼 + 기준요일·시각 피커 + 저장).
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
      {/* DialogTrigger asChild로 bespoke 트리거를 감싼다 — radix가 open 토글 + 닫힘 시
          트리거(triggerRef)로 포커스 복원(plan §1.3 c). 트리거 시각은 그대로 유지. */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          {configured && display ? (
            <button
              type="button"
              className={`sprint-count${display.overdue ? " is-overdue" : ""}`}
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
            <button type="button" className="sprint-empty-link">
              스프린트 설정
            </button>
          )}
        </DialogTrigger>
        <SprintEditor
          config={configQ.data ?? null}
          onClose={() => setOpen(false)}
        />
      </Dialog>
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

/** Dialog 에디터(shadcn Dialog 래퍼): interval_days 스테퍼 + 기준요일·시각 피커 + 저장. */
function SprintEditor({ config, onClose }: EditorProps) {
  // Esc/외부 클릭/포커스 복원/마운트는 PR 0 Dialog 래퍼(overlay-stack 계약, radix)가 전담(plan §0.6).
  // 필드 본체는 DialogContent 자식이라 열릴 때마다 마운트 → draft가 config로 매번 초기화된다.
  return (
    <DialogContent
      showClose={false}
      aria-describedby={undefined}
      className="w-[min(360px,92vw)] max-w-none gap-3.5 p-[22px]"
    >
      <DialogTitle className="font-mono text-[13px] font-semibold uppercase tracking-[0.1em]">
        스프린트 일정
      </DialogTitle>
      <SprintEditorFields config={config} onClose={onClose} />
    </DialogContent>
  );
}

function SprintEditorFields({ config, onClose }: EditorProps) {
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
    <>
      <label className="sprint-field">
        <span className="sprint-lbl">길이 (일)</span>
        <div className="sprint-stepper">
          <Button
            variant="outline"
            className="size-8 rounded-[var(--radius-sm)] p-0 text-lg font-medium"
            onClick={() => setIntervalDays((d) => Math.max(1, d - 1))}
            aria-label="길이 감소"
          >
            −
          </Button>
          <Input
            type="number"
            min={1}
            value={intervalDays}
            onChange={(e) =>
              setIntervalDays(Math.max(1, Number(e.target.value) || 1))
            }
            className="h-8 w-16 text-center font-mono font-semibold"
          />
          <Button
            variant="outline"
            className="size-8 rounded-[var(--radius-sm)] p-0 text-lg font-medium"
            onClick={() => setIntervalDays((d) => d + 1)}
            aria-label="길이 증가"
          >
            +
          </Button>
        </div>
      </label>

      <label className="sprint-field">
        <span className="sprint-lbl">기준 요일</span>
        <div className="sprint-wd-row">
          {WEEKDAYS.map((wd) => (
            <Button
              key={wd}
              variant="outline"
              size="sm"
              className={cn(
                "flex-1 rounded-[var(--radius-sm)] px-0 text-[13px] text-[color:var(--color-wr-subtle)]",
                wd === weekday &&
                  "border-[color:var(--color-wr-accent)] bg-[color:var(--color-wr-surface)] font-semibold text-foreground",
              )}
              onClick={() => setWeekday(wd)}
              aria-pressed={wd === weekday}
            >
              {WEEKDAY_LABELS[wd]}
            </Button>
          ))}
        </div>
      </label>

      <label className="sprint-field">
        <span className="sprint-lbl">기준 시각</span>
        <Input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className="w-[140px]"
        />
      </label>

      {setConfig.isError && (
        <div className="sprint-err">{String(setConfig.error)}</div>
      )}

      <div className="sprint-pop-actions">
        {config && (
          <Button
            variant="outline"
            className="rounded-full"
            onClick={remove}
            disabled={clearConfig.isPending}
          >
            해제
          </Button>
        )}
        <span className="sprint-actions-spacer" />
        <Button variant="outline" className="rounded-full" onClick={onClose}>
          취소
        </Button>
        <Button
          className="rounded-full px-[22px]"
          onClick={save}
          disabled={setConfig.isPending}
        >
          {setConfig.isPending ? "저장 중…" : "저장"}
        </Button>
      </div>
    </>
  );
}
