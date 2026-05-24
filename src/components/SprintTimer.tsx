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
 * 헤더 중앙 존 스프린트 미터 (P11, 2026-05-25 재설계) — 에디토리얼 1줄 라벨 + 얇은 진행 바.
 * 라벨 'SPRINT · {n일 남음}' + 3px 트랙(near-black 채움). 색만으로 의미 전달 금지 → 'SPRINT'/'남음/지남' 라벨 병기.
 * overdue=Coral 풀필 + 라벨 코랄. 미설정="SPRINT · 설정" + 점선 트랙(empty).
 * 클릭 → Dialog 에디터(interval_days 스테퍼 + 기준요일·시각 피커 + 저장).
 *
 * 다음 경계 SSOT = Rust `next_boundary`(직접 구현 + cargo test, DST 안전).
 * 진행도 = (intervalDays·86400 − remaining) / total — 매 1s tick으로 재계산(드리프트 없음).
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
  const config = configQ.data ?? null;
  const meter = useMemo(() => {
    if (!status || !config) return null;
    const secs = remainingSecondsUntil(status.nextBoundary, nowMs);
    if (secs == null) return null;
    const display = formatCountdown(secs);
    // 진행도 = 전체 인터벌 대비 경과 비율. overdue면 100% 채움(시각 cap).
    const totalSec = Math.max(1, config.intervalDays * 86_400);
    const elapsedSec = totalSec - secs;
    const pct = display.overdue
      ? 1
      : Math.max(0, Math.min(1, elapsedSec / totalSec));
    return { display, pct };
  }, [status, config, nowMs]);

  const configured = !!config;

  return (
    <div className="sprint-timer">
      {/* DialogTrigger asChild로 bespoke 트리거를 감싼다 — radix가 open 토글 + 닫힘 시
          트리거(triggerRef)로 포커스 복원(plan §1.3 c). 트리거 시각은 그대로 유지. */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          {configured && meter ? (
            <button
              type="button"
              className={`sprint-meter${meter.display.overdue ? " is-overdue" : ""}`}
              title="스프린트 일정 편집"
              aria-live="polite"
              aria-label={`스프린트 ${remainingLabel(meter.display)} (${Math.round(meter.pct * 100)}%)`}
            >
              <span className="sprint-meter-label">
                <span className="sprint-meter-tag">SPRINT</span>
                <span className="sprint-meter-sep" aria-hidden>
                  ·
                </span>
                <span className="sprint-meter-text">
                  {remainingLabel(meter.display)}
                </span>
              </span>
              <span className="sprint-meter-bar" aria-hidden>
                <span
                  className="sprint-meter-fill"
                  style={{ width: `${meter.pct * 100}%` }}
                />
              </span>
            </button>
          ) : (
            <button
              type="button"
              className="sprint-meter is-empty"
              title="스프린트 일정 설정"
            >
              <span className="sprint-meter-label">
                <span className="sprint-meter-tag">SPRINT</span>
                <span className="sprint-meter-sep" aria-hidden>
                  ·
                </span>
                <span className="sprint-meter-text">설정</span>
              </span>
              <span className="sprint-meter-bar" aria-hidden />
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

/**
 * 라벨 텍스트 — 'D일 남음' / 'HH:MM 남음' / 'D일 지남'.
 * 포맷 SSOT는 `formatCountdown` (D일 HH:MM). 매치 실패 시 원문 폴백.
 */
function remainingLabel(display: {
  text: string;
  overdue: boolean;
}): string {
  const m = display.text.match(/^(\d+)일 (\d{2}):(\d{2})$/);
  if (!m) return display.text;
  const [, dStr, hh, mm] = m;
  const days = Number(dStr);
  if (display.overdue) {
    return days > 0 ? `${days}일 지남` : `${hh}:${mm} 지남`;
  }
  return days > 0 ? `${days}일 남음` : `${hh}:${mm} 남음`;
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
