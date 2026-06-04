import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  useApproveExternalAction,
  usePendingActions,
  useRejectExternalAction,
} from "@/lib/query/pendingActions";

import { formatActionKind, groupPendingByOrigin, isExternalWriteKind } from "./pendingActions";

export function PendingActionsPanel() {
  const { data: actions = [] } = usePendingActions();
  const approve = useApproveExternalAction();
  const reject = useRejectExternalAction();

  if (actions.length === 0) return null;
  const groups = [...groupPendingByOrigin(actions).entries()];

  return (
    <section aria-label="승인 대기 외부 액션" className="flex flex-col gap-3">
      {groups.map(([origin, items]) => (
        <div key={origin} className="flex flex-col gap-2">
          <p className="text-muted-foreground typo-label-sm">{origin}</p>
          {items.map((a) => (
            <div
              key={a.id}
              className="border-border flex items-start justify-between gap-2 rounded-md border p-2"
            >
              <div className="min-w-0">
                <p className="typo-title-sm">{formatActionKind(a.kind)}</p>
                {a.preview ? (
                  <p className="text-muted-foreground typo-caption-sm truncate">{a.preview}</p>
                ) : null}
                {isExternalWriteKind(a.kind) ? (
                  // 잔여 위험(#5): POST 도달 후 응답 유실 → failed 표시 → 재승인이 중복 외부 쓰기일 수
                  // 있다. idempotency_key는 제안 dedup이지 API 효과 dedup이 아니므로 사람에게 명시한다.
                  <p className="text-muted-foreground typo-caption-sm">
                    전송 후 응답이 유실되면 재승인이 중복 쓰기일 수 있어요 — 승인 전 대상에서
                    확인하세요.
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="승인"
                  className="size-7 p-0"
                  onClick={() => approve.mutate(a.id)}
                >
                  <Check className="size-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="거절"
                  className="size-7 p-0"
                  onClick={() => reject.mutate(a.id)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
