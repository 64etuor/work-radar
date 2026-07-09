import { useState } from "react";

import { Slider } from "@/components/ui/slider";

import {
  clampMarqueeSpeed,
  MARQUEE_SPEED_MAX,
  MARQUEE_SPEED_MIN,
  marqueeSpeedToSeconds,
  secondsToMarqueeSpeed,
} from "./marqueeSpeed";

export function NewsMarqueeSpeedField({
  disabled,
  seconds,
  onCommit,
}: {
  disabled: boolean;
  seconds: number;
  onCommit: (seconds: number) => void;
}) {
  const initialSpeed = secondsToMarqueeSpeed(seconds);
  const [draft, setDraft] = useState(initialSpeed);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="text-foreground typo-label-md">마퀴 속도</div>
        <div className="text-muted-foreground typo-caption-sm max-w-[28rem] text-right">
          뉴스가 흘러가는 체감 속도입니다. 기본은 보통.
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <div className="relative pt-1">
          <Slider
            value={[draft]}
            min={MARQUEE_SPEED_MIN}
            max={MARQUEE_SPEED_MAX}
            step={1}
            disabled={disabled}
            onValueChange={([v]) => setDraft(clampMarqueeSpeed(v ?? initialSpeed))}
            onValueCommit={([v]) => {
              const next = clampMarqueeSpeed(v ?? initialSpeed);
              setDraft(next);
              onCommit(marqueeSpeedToSeconds(next));
            }}
            aria-label="뉴스 마퀴 속도"
          />
          <div className="pointer-events-none mt-1 flex justify-between px-1">
            {Array.from({ length: MARQUEE_SPEED_MAX - MARQUEE_SPEED_MIN + 1 }, (_, i) => (
              <span key={i} className="bg-border h-1.5 w-px rounded-full" aria-hidden="true" />
            ))}
          </div>
        </div>
        <div className="text-muted-foreground flex items-center justify-between px-0.5 text-xs">
          <span>느림</span>
          <span>빠름</span>
        </div>
      </div>
    </div>
  );
}
