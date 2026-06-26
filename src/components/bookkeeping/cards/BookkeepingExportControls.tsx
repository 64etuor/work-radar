import { Download } from "lucide-react";

import type { BookkeepingExportFormat } from "@/bindings";
import { Button } from "@/components/ui/button";

export function BookkeepingExportControls({
  disabled,
  onExport,
}: {
  disabled: boolean;
  onExport: (format: BookkeepingExportFormat) => void;
}) {
  return (
    <div className="bk-export-actions" role="group" aria-label="가계부 내보내기">
      {(["csv", "qif", "ofx"] as const).map((format) => (
        <Button
          key={format}
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => onExport(format)}
        >
          <Download className="size-3.5" />
          {format.toUpperCase()}
        </Button>
      ))}
    </div>
  );
}
