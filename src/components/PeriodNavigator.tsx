import "./PeriodNavigator.css";

import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";

type PeriodNavigatorSize = "default" | "compact";

type PeriodNavigatorProps = {
  label?: string;
  valueLabel: string;
  previousLabel: string;
  nextLabel: string;
  resetLabel?: string;
  resetDisabled?: boolean;
  size?: PeriodNavigatorSize;
  className?: string;
  extra?: ReactNode;
  onPrevious: () => void;
  onNext: () => void;
  onReset?: () => void;
};

export function PeriodNavigator({
  label,
  valueLabel,
  previousLabel,
  nextLabel,
  resetLabel,
  resetDisabled = false,
  size = "default",
  className,
  extra,
  onPrevious,
  onNext,
  onReset,
}: PeriodNavigatorProps) {
  const resetAriaLabel = resetLabel ? `${valueLabel} · ${resetLabel}` : valueLabel;
  return (
    <div className={cn("period-nav", className)} data-size={size}>
      {label ? <span className="period-nav-label typo-caption-sm">{label}</span> : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="period-nav-icon"
        aria-label={previousLabel}
        onClick={onPrevious}
      >
        <ChevronLeft className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="period-nav-value typo-body-strong"
        aria-label={resetAriaLabel}
        aria-disabled={resetDisabled}
        onClick={() => {
          if (!resetDisabled) {
            onReset?.();
          }
        }}
      >
        {valueLabel}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="period-nav-icon"
        aria-label={nextLabel}
        onClick={onNext}
      >
        <ChevronRight className="size-4" />
      </Button>
      {extra ? <div className="period-nav-extra">{extra}</div> : null}
    </div>
  );
}
