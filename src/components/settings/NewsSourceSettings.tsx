// 설정 → 뉴스 카테고리. 키워드 필터(D-Safe) + 소스별 on/off 토글. 즉시 반영 + 토스트.
// INVARIANT #1: 뉴스는 표시 전용 — 토글/필터가 결정 레일 어떤 데이터도 안 건드림.

import { useState } from "react";
import { X } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useToastStore } from "@/lib/toast";
import {
  useNewsSources,
  useSetNewsSourceEnabled,
  useNewsFilters,
  useAddNewsFilter,
  useRemoveNewsFilter,
} from "@/lib/query/news";
import type { FilterMode, KeywordFilter } from "@/bindings";
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
      <NewsFiltersForm onToast={onToast} />

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

function NewsFiltersForm({ onToast }: { onToast: (msg: string) => void }) {
  const q = useNewsFilters();
  const add = useAddNewsFilter();
  const remove = useRemoveNewsFilter();
  const [kw, setKw] = useState("");
  const [mode, setMode] = useState<FilterMode>("include");

  const submit = () => {
    const trimmed = kw.trim();
    if (!trimmed) return;
    add.mutate(
      { keyword: trimmed, mode },
      {
        onSuccess: () => {
          setKw("");
          onToast(`${mode === "include" ? "포함" : "제외"} 키워드 추가: ${trimmed}`);
        },
      },
    );
  };

  const list = q.data ?? [];
  const includes = list.filter((f) => f.mode === "include");
  const excludes = list.filter((f) => f.mode === "exclude");

  return (
    <section className="rounded-xl border border-border p-4 flex flex-col gap-3">
      <SectionLabel>키워드 필터</SectionLabel>
      <div className="flex gap-2">
        <Input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="예: AI, Rust, crypto"
          className="flex-1"
        />
        <Select value={mode} onValueChange={(v) => setMode(v as FilterMode)}>
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="include">포함</SelectItem>
            <SelectItem value="exclude">제외</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={submit} disabled={!kw.trim() || add.isPending}>
          추가
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        포함: 적어도 하나의 키워드를 포함한 제목만 표시(OR). 제외: 이 키워드를 포함한 제목 숨김(AND).
        대소문자 무관, 부분 일치. 빈 리스트면 전체 표시.
      </p>
      {includes.length > 0 && (
        <div>
          <SectionLabel className="mb-1.5">포함</SectionLabel>
          <ChipList list={includes} onRemove={(id) => remove.mutate(id)} />
        </div>
      )}
      {excludes.length > 0 && (
        <div>
          <SectionLabel className="mb-1.5">제외</SectionLabel>
          <ChipList list={excludes} onRemove={(id) => remove.mutate(id)} />
        </div>
      )}
    </section>
  );
}

function ChipList({
  list,
  onRemove,
}: {
  list: KeywordFilter[];
  onRemove: (id: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((f) => (
        <span
          key={f.id}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-xs"
        >
          {f.keyword}
          <button
            type="button"
            onClick={() => onRemove(f.id)}
            aria-label={`${f.keyword} 제거`}
            className="rounded-full p-0.5 hover:bg-hover"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
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
