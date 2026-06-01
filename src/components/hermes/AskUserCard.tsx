import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { HermesMessage } from "./types";

type AskMessage = Extract<HermesMessage, { role: "ask" }>;

interface Props {
  message: AskMessage;
  /** (optionId, cancelled) — optionId is "" when cancelled. */
  onRespond: (optionId: string, cancelled: boolean) => void;
}

/** Agent-initiated "ask the user" prompt rendered as a tappable shadcn card.
 *  Pure presentational — all routing is delegated to `onRespond`. */
export function AskUserCard({ message, onRespond }: Props) {
  const resolved = message.resolved;
  const isResolved = resolved !== undefined;
  const cancelled = resolved === "cancelled";

  return (
    <div className="border-border bg-muted/30 my-1 rounded-lg border p-3 text-left">
      {message.toolName && (
        <p className="text-muted-foreground mb-2 font-mono text-xs">{message.toolName}</p>
      )}
      <div
        role="group"
        aria-label={message.toolName ?? "에이전트 선택 요청"}
        className="flex flex-col gap-1.5"
      >
        {message.options.map((o) => {
          const chosen = resolved === o.id;
          return (
            <Button
              key={o.id}
              type="button"
              variant={chosen ? "default" : "outline"}
              aria-pressed={isResolved ? chosen : undefined}
              disabled={isResolved}
              className={cn("justify-start", chosen && "font-medium")}
              onClick={() => onRespond(o.id, false)}
            >
              {o.label}
            </Button>
          );
        })}
      </div>
      {!isResolved ? (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground mt-2 text-xs underline"
          onClick={() => onRespond("", true)}
        >
          취소
        </button>
      ) : (
        <p className="text-muted-foreground mt-2 text-xs">{cancelled ? "취소됨" : "응답함"}</p>
      )}
    </div>
  );
}
