import { X } from "lucide-react";
import { useState } from "react";

import type { FilterMode, KeywordFilter } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAddNewsFilter, useNewsFilters, useRemoveNewsFilter } from "@/lib/query/news";

import { SectionLabel } from "./SettingsKit";

function ChipList({ list, onRemove }: { list: KeywordFilter[]; onRemove: (id: number) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((f) => (
        <span
          key={f.id}
          className="border-border bg-muted inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs"
        >
          {f.keyword}
          <button
            type="button"
            onClick={() => onRemove(f.id)}
            aria-label={`${f.keyword} 제거`}
            className="hover:bg-hover rounded-full p-0.5"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

export function NewsFiltersForm({ onToast }: { onToast: (msg: string) => void }) {
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
    <section className="border-border bg-card/80 rounded-2xl border p-5 shadow-[var(--wr-shadow-hairline)]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <SectionLabel>키워드 필터</SectionLabel>
          <p className="text-muted-foreground mt-1 text-xs">
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
      <p className="text-muted-foreground mt-2 text-xs">
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
