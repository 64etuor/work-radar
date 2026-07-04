import { Download } from "lucide-react";
import { useState } from "react";

import type { BookkeepingExportFormat } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * 가계부 내보내기 — 헤더에 CSV/QIF/OFX 버튼 3개를 늘어놓는 대신 내려받기 아이콘 하나만 두고,
 * 클릭 시 팝업(Popover)에서 포맷을 고른다(사용자 피드백 2026-07-04). 포맷 선택 즉시 내보내고 닫는다.
 */
export function BookkeepingExportControls({
  disabled,
  onExport,
}: {
  disabled: boolean;
  onExport: (format: BookkeepingExportFormat) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          aria-label="가계부 내보내기"
          title="내보내기"
        >
          <Download className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="bk-export-popover" align="end">
        <div className="bk-export-actions" role="group" aria-label="내보내기 포맷 선택">
          {(["csv", "qif", "ofx"] as const).map((format) => (
            <Button
              key={format}
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                onExport(format);
                setOpen(false);
              }}
            >
              <Download className="size-3.5" />
              {format.toUpperCase()}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
