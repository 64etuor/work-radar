import { useRef, useState } from "react";

import { cn } from "@/components/ui/cn";
import { eventToHotkeySpec } from "@/lib/hotkey";

export interface HotkeyCaptureProps {
  value: string;
  onChange: (spec: string) => void;
  label?: string;
  description?: string;
}

/**
 * 모디파이어+키 조합을 캡처하는 재사용 위젯.
 * 허용 modifier: Ctrl/Alt/Shift/Cmd(Meta). 조합이 완성되면 "Ctrl+Space" 형식으로 onChange 호출.
 * Escape(단독)면 취소.
 */
export function HotkeyCapture({ value, onChange, label, description }: HotkeyCaptureProps) {
  const [recording, setRecording] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    // modifier 없이 Escape면 캡처 취소.
    if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      setRecording(false);
      return;
    }
    const spec = eventToHotkeySpec(e);
    // modifier-only/단일키/미지원 → 계속 대기. 글로벌 핫키는 modifier 필수.
    if (!spec) return;
    onChange(spec);
    setRecording(false);
  };

  const start = () => {
    setRecording(true);
    btnRef.current?.focus();
  };

  return (
    <div className="flex flex-col gap-1.5">
      {label && <span className="text-muted-foreground text-xs">{label}</span>}
      <div className="flex-1">
        <button
          ref={btnRef}
          type="button"
          className={cn(
            "border-input bg-background text-foreground focus-visible:ring-ring flex h-9 w-full items-center rounded-md border px-3 font-mono text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none",
            recording && "border-primary ring-ring ring-2",
          )}
          onClick={start}
          onKeyDown={handleKeyDown}
          onBlur={() => setRecording(false)}
          aria-label={label ? `${label} 핫키 캡처` : "핫키 캡처"}
          title={recording ? "단축키를 누르세요 (Esc = 취소)" : "클릭 후 단축키 입력"}
        >
          {recording ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full bg-[color:var(--destructive)]"
              />
              단축키를 누르세요…
            </span>
          ) : (
            value || "캡처하려면 클릭"
          )}
        </button>
      </div>
      {description && <p className="text-muted-foreground text-xs">{description}</p>}
    </div>
  );
}
