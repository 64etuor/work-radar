// 설정 → 뉴스 카테고리. 글로벌 옵션(D-Tune) + 키워드 필터(D-Safe) + 소스별 on/off 토글(카테고리 그룹). 즉시 반영 + 토스트.
// INVARIANT #1: 뉴스는 표시 전용 — 토글/필터/옵션이 결정 레일 어떤 데이터도 안 건드림.

import { useMemo, useState } from "react";
import { X, ChevronDown, ChevronRight } from "lucide-react";
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
import { Slider } from "@/components/ui/slider";
import { useToastStore } from "@/lib/toast";
import {
  useNewsSources,
  useSetNewsSourceEnabled,
  useNewsFilters,
  useAddNewsFilter,
  useRemoveNewsFilter,
  useNewsOptions,
  useSetNewsOptions,
} from "@/lib/query/news";
import type {
  FilterMode,
  KeywordFilter,
  NewsCategory,
  NewsOptions,
  NewsSourceMeta,
  SortMode,
} from "@/bindings";
import { Field, SectionLabel } from "./kit";

const CATEGORY_LABEL: Record<NewsCategory, string> = {
  koreanTech: "한글 기술블로그",
  englishTech: "영문 기술",
  aiResearch: "AI/ML 연구",
};
const CATEGORY_ORDER: NewsCategory[] = ["koreanTech", "englishTech", "aiResearch"];

export function NewsSourceSettings({
  onToast,
}: {
  onToast: (msg: string) => void;
}) {
  const sources = useNewsSources();
  const setEnabled = useSetNewsSourceEnabled();
  const { pushError } = useToastStore();
  const [collapsed, setCollapsed] = useState<Set<NewsCategory>>(new Set());

  const grouped = useMemo(() => {
    const out: Record<NewsCategory, NewsSourceMeta[]> = {
      koreanTech: [],
      englishTech: [],
      aiResearch: [],
    };
    (sources.data ?? []).forEach((s) => out[s.category].push(s));
    return out;
  }, [sources.data]);

  const toggleCollapsed = (c: NewsCategory) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  const setCategoryAll = (cat: NewsCategory, enabled: boolean) => {
    grouped[cat].forEach((src) => {
      if (src.enabled !== enabled) {
        setEnabled.mutate(
          { source: src.id, enabled },
          { onError: () => pushError("news", `${src.label} 토글 실패`) },
        );
      }
    });
    onToast(`${CATEGORY_LABEL[cat]} ${enabled ? "전부 켰습니다" : "전부 껐습니다"}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <NewsOptionsForm onToast={onToast} />
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
      {sources.data &&
        CATEGORY_ORDER.map((cat) => {
          const list = grouped[cat];
          if (list.length === 0) return null;
          const isCollapsed = collapsed.has(cat);
          const onCount = list.filter((s) => s.enabled).length;
          return (
            <section key={cat} className="rounded-xl border border-border">
              <header className="flex items-center justify-between gap-3 px-4 py-2.5">
                <button
                  type="button"
                  onClick={() => toggleCollapsed(cat)}
                  className="flex items-center gap-2 text-[13px] font-medium text-foreground"
                >
                  {isCollapsed ? (
                    <ChevronRight className="size-4" />
                  ) : (
                    <ChevronDown className="size-4" />
                  )}
                  {CATEGORY_LABEL[cat]}
                  <span className="text-xs text-muted-foreground">
                    {onCount}/{list.length}
                  </span>
                </button>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCategoryAll(cat, true)}
                  >
                    전부 ON
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCategoryAll(cat, false)}
                  >
                    전부 OFF
                  </Button>
                </div>
              </header>
              {!isCollapsed && (
                <div className="flex flex-col divide-y divide-border border-t border-border">
                  {list.map((src) => (
                    <label
                      key={src.id}
                      htmlFor={`news-src-${src.id}`}
                      className="flex cursor-pointer items-center justify-between gap-3 px-4 py-2.5"
                    >
                      <span className="text-[13px] text-foreground">
                        {src.label}
                      </span>
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
                                pushError("news", `${src.label} 토글 실패`),
                            },
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      <p className="text-xs text-muted-foreground">
        15분마다 백그라운드에서 갱신 — 토글/필터 변경은 다음 페치부터 반영.
      </p>
    </div>
  );
}

function NewsOptionsForm({ onToast }: { onToast: (msg: string) => void }) {
  const q = useNewsOptions();
  const m = useSetNewsOptions();
  const o = q.data;
  if (!o) return null;
  const update = (patch: Partial<NewsOptions>) =>
    m.mutate(
      { ...o, ...patch },
      { onSuccess: () => onToast("옵션 저장됨 — 다음 페치부터 적용") },
    );

  return (
    <section className="rounded-xl border border-border p-4 flex flex-col gap-3">
      <SectionLabel>표시 옵션</SectionLabel>
      <Field label="총 표시 개수" hint="티커가 동시에 보여줄 최대(5~100)">
        <Input
          type="number"
          min={5}
          max={100}
          step={1}
          inputMode="numeric"
          value={o.totalLimit}
          onChange={(e) => {
            const n = Math.trunc(Number(e.target.value));
            if (Number.isNaN(n)) return;
            update({ totalLimit: Math.max(5, Math.min(100, n)) });
          }}
        />
      </Field>
      <Field
        label="소스당 최대 개수"
        hint="0이면 무제한(한 소스가 티커를 독점할 수 있음)"
      >
        <Input
          type="number"
          min={0}
          max={50}
          step={1}
          inputMode="numeric"
          value={o.perSourceLimit}
          onChange={(e) => {
            const n = Math.trunc(Number(e.target.value));
            if (Number.isNaN(n)) return;
            update({ perSourceLimit: Math.max(0, Math.min(50, n)) });
          }}
        />
      </Field>
      <Field label="정렬">
        <Select
          value={o.sortMode}
          onValueChange={(v) => update({ sortMode: v as SortMode })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">최신순</SelectItem>
            <SelectItem value="comments">댓글 많은 순</SelectItem>
            <SelectItem value="mixed">소스 라운드로빈</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label="갱신 주기"
        hint="0=자동 갱신 끔(설정 변경 시 즉시 깨움)"
      >
        <Select
          value={String(o.fetchIntervalMinutes)}
          onValueChange={(v) => update({ fetchIntervalMinutes: Number(v) })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0">자동 갱신 끔</SelectItem>
            <SelectItem value="5">5분</SelectItem>
            <SelectItem value="10">10분</SelectItem>
            <SelectItem value="15">15분(기본)</SelectItem>
            <SelectItem value="30">30분</SelectItem>
            <SelectItem value="60">60분</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <NewsMarqueeSpeedField
        key={o.marqueeSeconds}
        disabled={m.isPending}
        seconds={o.marqueeSeconds}
        onCommit={(marqueeSeconds) => update({ marqueeSeconds })}
      />
    </section>
  );
}

function NewsMarqueeSpeedField({
  disabled,
  seconds,
  onCommit,
}: {
  disabled: boolean;
  seconds: number;
  onCommit: (seconds: number) => void;
}) {
  const [draft, setDraft] = useState(seconds);

  return (
    <Field
      label="마퀴 속도"
      hint="왼쪽으로 한 바퀴 도는 시간. 짧을수록 빠르게 흐릅니다."
    >
      <div className="flex items-center gap-3">
        <Slider
          value={[draft]}
          min={20}
          max={180}
          step={5}
          disabled={disabled}
          onValueChange={([v]) => setDraft(v ?? seconds)}
          onValueCommit={([v]) => {
            const next = Math.max(20, Math.min(180, Math.trunc(v ?? seconds)));
            setDraft(next);
            onCommit(next);
          }}
          aria-label="뉴스 마퀴 속도"
        />
        <span className="w-14 shrink-0 text-right font-mono text-xs text-muted-foreground">
          {draft}s
        </span>
      </div>
    </Field>
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
        포함: 적어도 하나의 키워드를 포함한 제목만 표시(OR). 제외: 이 키워드를 포함한 제목
        숨김(AND). 대소문자 무관, 부분 일치. 빈 리스트면 전체 표시.
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
