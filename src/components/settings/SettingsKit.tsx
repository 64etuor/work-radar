import type { ReactNode } from "react";

import { cn } from "@/components/ui/cn";

/** 섹션 라벨 — 작은 mono uppercase, 절제된 위계. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "text-subtle font-mono text-[11px] font-semibold tracking-[0.12em] uppercase",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** 폼 필드 — 라벨 위, 보조 설명 아래. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-foreground text-[13px] font-medium">
        {label}
      </label>
      {children}
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </div>
  );
}

/** 연결 상태 점 + 라벨. */
export function StatusDot({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium",
        on ? "text-[color:var(--success)]" : "text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          on ? "bg-[color:var(--success)]" : "bg-border-strong",
        )}
      />
      {children}
    </span>
  );
}

/** 세그먼트 컨트롤 — 자연 너비. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  size?: "md" | "sm";
}) {
  return (
    <div
      className={cn(
        "border-border bg-muted inline-flex w-fit items-center self-start rounded-lg border p-0.5",
        size === "md" ? "h-9" : "h-8",
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "h-full rounded-md px-3.5 font-medium transition-colors",
            size === "md" ? "text-[13px]" : "text-xs",
            value === o.value
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
