// 설정 → 뉴스 카테고리. 소스별 on/off 토글. 즉시 반영 + 토스트.
// INVARIANT #1: 뉴스는 표시 전용 — 토글이 결정 레일 어떤 데이터도 안 건드림.

import { Switch } from "@/components/ui/switch";
import { useToastStore } from "@/lib/toast";
import { useNewsSources, useSetNewsSourceEnabled } from "@/lib/query/news";
import { SectionLabel } from "./kit";

export function NewsSourceSettings({
  onToast,
}: {
  onToast: (msg: string) => void;
}) {
  const sources = useNewsSources();
  const setEnabled = useSetNewsSourceEnabled();
  const { pushError } = useToastStore();

  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>뉴스 소스</SectionLabel>

      {sources.isLoading && (
        <div className="text-sm text-muted-foreground">불러오는 중…</div>
      )}
      {sources.isError && (
        <div className="text-sm text-[color:var(--destructive)]">
          소스 목록 로드 실패: {String(sources.error)}
        </div>
      )}

      {sources.data && (
        <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {sources.data.map((src) => (
            <label
              key={src.id}
              htmlFor={`news-src-${src.id}`}
              className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium text-foreground">
                  {src.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  {sourceHint(src.id)}
                </span>
              </div>
              <Switch
                id={`news-src-${src.id}`}
                checked={src.enabled}
                disabled={setEnabled.isPending}
                onCheckedChange={(checked) =>
                  setEnabled.mutate(
                    { source: src.id, enabled: checked },
                    {
                      onSuccess: () =>
                        onToast(
                          `${src.label} ${checked ? "켰습니다" : "껐습니다"}`,
                        ),
                      // critic What's-Missing #3: 실패 시 사용자 surface. invalidate가
                      // 다음 sources refetch에서 토글을 원위치로 되돌리지만 그 사이에
                      // 무엇이 잘못됐는지 안내.
                      onError: () =>
                        pushError("news", `${src.label} 토글 실패 — 다시 시도하세요`),
                    },
                  )
                }
              />
            </label>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        15분마다 백그라운드에서 갱신 — 토글 변경은 다음 페치부터 반영(기존 캐시는 즉시 숨김).
      </p>
    </div>
  );
}

function sourceHint(id: string): string {
  switch (id) {
    case "hn":
      return "Hacker News 상위 30건(JSON API)";
    case "geeknews":
      return "GeekNews(news.hada.io) RSS";
    case "lobsters":
      return "Lobsters hottest(JSON API)";
    default:
      return "";
  }
}
