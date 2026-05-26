// 설정 → 뉴스 카테고리. 글로벌 옵션(D-Tune) + 키워드 필터(D-Safe) + 소스별 on/off 토글(카테고리 그룹). 즉시 반영 + 토스트.
// INVARIANT #1: 뉴스는 표시 전용 — 토글/필터/옵션이 결정 레일 어떤 데이터도 안 건드림.

import { useMemo, useState, type ReactNode } from "react";
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
import { SectionLabel } from "./kit";

const MARQUEE_SPEED_MIN = 1;
const MARQUEE_SPEED_MAX = 9;

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
  const update = (patch: Partial<NewsOptions>, toast = "옵션 저장됨") =>
    m.mutate(
      { ...o, ...patch },
      { onSuccess: () => toast && onToast(toast) },
    );

  return (
    <section className="rounded-2xl border border-border bg-card/80 p-5 shadow-[0_1px_0_rgba(255,255,255,0.35)]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <SectionLabel>표시 옵션</SectionLabel>
          <p className="mt-1 text-xs text-muted-foreground">
            뉴스 개수와 정렬, 마퀴 체감 속도를 한 곳에서 조절합니다.
          </p>
        </div>
        <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
          실시간 반영
        </span>
      </div>

      <div className="mt-4 grid gap-2 md:grid-cols-2">
        <OptionRow label="총 표시 개수" hint="티커 최대 5~100개">
          <Input
            type="number"
            min={5}
            max={100}
            step={1}
            inputMode="numeric"
            value={o.totalLimit}
            className="h-8 w-32 text-right"
            onChange={(e) => {
              const n = Math.trunc(Number(e.target.value));
              if (Number.isNaN(n)) return;
              update({ totalLimit: Math.max(5, Math.min(100, n)) });
            }}
          />
        </OptionRow>

        <OptionRow
          label="소스당 최대"
          hint="0이면 소스별 제한 없음"
        >
          <Input
            type="number"
            min={0}
            max={50}
            step={1}
            inputMode="numeric"
            value={o.perSourceLimit}
            className="h-8 w-32 text-right"
            onChange={(e) => {
              const n = Math.trunc(Number(e.target.value));
              if (Number.isNaN(n)) return;
              update({ perSourceLimit: Math.max(0, Math.min(50, n)) });
            }}
          />
        </OptionRow>

        <OptionRow label="정렬" hint="티커 후보 우선순위">
          <Select
            value={o.sortMode}
            onValueChange={(v) => update({ sortMode: v as SortMode })}
          >
            <SelectTrigger className="h-8 w-32 [&>span]:flex-1 [&>span]:text-right">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">최신순</SelectItem>
              <SelectItem value="comments">댓글 많은 순</SelectItem>
              <SelectItem value="mixed">소스 라운드로빈</SelectItem>
            </SelectContent>
          </Select>
        </OptionRow>

        <OptionRow
          label="갱신 주기"
          hint="설정 변경 시 즉시 깨움"
        >
          <Select
            value={String(o.fetchIntervalMinutes)}
            onValueChange={(v) => update({ fetchIntervalMinutes: Number(v) })}
          >
            <SelectTrigger className="h-8 w-32 [&>span]:flex-1 [&>span]:text-right">
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
        </OptionRow>

        <div className="md:col-span-2 rounded-xl border border-border/70 bg-muted/15 px-3 py-3">
          <NewsMarqueeSpeedField
            key={o.marqueeSeconds}
            disabled={m.isPending}
            seconds={o.marqueeSeconds}
            onCommit={(marqueeSeconds) => update({ marqueeSeconds }, "")}
          />
        </div>
        <OptionRow
          className="md:col-span-2"
          label="핫 뉴스만 표시"
          hint="댓글이 붙은 hot/trending 항목만 표시"
        >
          <Switch
            checked={o.hotOnly}
            disabled={m.isPending}
            onCheckedChange={(checked) =>
              update(
                { hotOnly: checked },
                `핫 뉴스만 표시 ${checked ? "켰습니다" : "껐습니다"}`,
              )
            }
          />
        </OptionRow>
      </div>
    </section>
  );
}

function OptionRow({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex min-h-14 items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/15 px-3 py-2.5 ${className ?? ""}`}
    >
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-foreground">{label}</div>
        {hint && (
          <div className="mt-0.5 truncate text-[11px] leading-snug text-muted-foreground">
            {hint}
          </div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
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
  const initialSpeed = secondsToMarqueeSpeed(seconds);
  const [draft, setDraft] = useState(initialSpeed);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="text-[13px] font-medium text-foreground">마퀴 속도</div>
        <div className="max-w-[28rem] text-right text-[11px] leading-snug text-muted-foreground">
          뉴스가 흘러가는 체감 속도입니다. 기본은 보통.
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <div className="relative pt-1">
          <Slider
            value={[draft]}
            min={MARQUEE_SPEED_MIN}
            max={MARQUEE_SPEED_MAX}
            step={1}
            disabled={disabled}
            onValueChange={([v]) => setDraft(clampMarqueeSpeed(v ?? initialSpeed))}
            onValueCommit={([v]) => {
              const next = clampMarqueeSpeed(v ?? initialSpeed);
              setDraft(next);
              onCommit(marqueeSpeedToSeconds(next));
            }}
            aria-label="뉴스 마퀴 속도"
          />
          <div className="pointer-events-none mt-1 flex justify-between px-1">
            {Array.from(
              { length: MARQUEE_SPEED_MAX - MARQUEE_SPEED_MIN + 1 },
              (_, i) => (
                <span
                  key={i}
                  className="h-1.5 w-px rounded-full bg-border"
                  aria-hidden="true"
                />
              ),
            )}
          </div>
        </div>
        <div className="flex items-center justify-between px-0.5 text-xs text-muted-foreground">
          <span>느림</span>
          <span>빠름</span>
        </div>
      </div>
    </div>
  );
}

function clampMarqueeSpeed(value: number): number {
  return Math.max(
    MARQUEE_SPEED_MIN,
    Math.min(MARQUEE_SPEED_MAX, Math.trunc(value)),
  );
}

function marqueeSpeedToSeconds(speed: number): number {
  const bySpeed: Record<number, number> = {
    1: 180,
    2: 150,
    3: 120,
    4: 90,
    5: 60,
    6: 45,
    7: 35,
    8: 28,
    9: 20,
  };
  return bySpeed[clampMarqueeSpeed(speed)] ?? 60;
}

function secondsToMarqueeSpeed(seconds: number): number {
  if (seconds >= 165) return 1;
  if (seconds >= 135) return 2;
  if (seconds >= 105) return 3;
  if (seconds >= 75) return 4;
  if (seconds >= 53) return 5;
  if (seconds >= 40) return 6;
  if (seconds >= 32) return 7;
  if (seconds >= 24) return 8;
  return 9;
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
    <section className="rounded-2xl border border-border bg-card/80 p-5 shadow-[0_1px_0_rgba(255,255,255,0.35)]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <SectionLabel>키워드 필터</SectionLabel>
          <p className="mt-1 text-xs text-muted-foreground">
            포함은 OR, 제외는 AND. 빈 리스트면 전체를 보여줍니다.
          </p>
        </div>
      </div>
      <div className="mt-4 grid gap-2 md:grid-cols-[minmax(0,1fr)_8rem_auto]">
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
          className="w-full"
        />
        <Select value={mode} onValueChange={(v) => setMode(v as FilterMode)}>
          <SelectTrigger>
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
      <p className="mt-2 text-xs text-muted-foreground">
        대소문자 무관, 부분 일치. 필터를 비우면 전체 표시.
      </p>
      {includes.length > 0 && (
        <div className="mt-4">
          <SectionLabel className="mb-1.5">포함</SectionLabel>
          <ChipList list={includes} onRemove={(id) => remove.mutate(id)} />
        </div>
      )}
      {excludes.length > 0 && (
        <div className="mt-4">
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
