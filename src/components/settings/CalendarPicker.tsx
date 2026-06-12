import { Check, Star } from "lucide-react";
import { useState } from "react";

import { cn } from "@/components/ui/cn";
import {
  useGoogleCalendars,
  useProjects,
  useSetProjectDefaultWriteCalendar,
  useSetSelectedCalendars,
} from "@/lib/query";

import { SectionLabel } from "./SettingsKit";

/** 연결된 프로젝트의 calendarList 다중 선택. 선택 목록만 로컬 SQLite SSOT. */
export function CalendarPicker({
  projectId,
  onToast,
}: {
  projectId: string;
  onToast: (msg: string) => void;
}) {
  const calendars = useGoogleCalendars(projectId, true);
  const save = useSetSelectedCalendars();
  const projects = useProjects();
  const setDefault = useSetProjectDefaultWriteCalendar();
  // 타임라인 기본 캘린더(프로젝트별) — 포함된 캘린더 중 하나만 지정 가능.
  const defaultCalendarId =
    projects.data?.find((p) => p.id === projectId)?.defaultWriteCalendarId ?? null;
  const pickDefault = (calendarId: string | null) =>
    setDefault.mutate({ projectId, calendarId }, { onError: (e) => onToast(String(e)) });
  // optimistic: 체크박스 토글 즉시 mutate. 서버 응답이 늦어도 즉시 반응 보이도록
  // 직전 토글 결과를 로컬에 잠깐 가지고 있다가 서버 데이터가 따라잡으면 비운다.
  const [pendingChecked, setPendingChecked] = useState<Set<string> | null>(null);
  const savedChecked = new Set<string>();
  for (const calendar of calendars.data ?? []) {
    if (calendar.selected) savedChecked.add(calendar.id);
  }
  const checked = pendingChecked ?? savedChecked;

  const toggle = (id: string) => {
    if (!calendars.data) return;
    const next = new Set(checked);
    const removing = next.has(id);
    if (removing) next.delete(id);
    else next.add(id);
    setPendingChecked(next);
    // 포함 해제하는 캘린더가 현재 기본이면 기본도 해제 — 포함 안 된 캘린더는 기본일 수 없다.
    if (removing && defaultCalendarId === id) pickDefault(null);
    const selected: Array<{ id: string; summary: string }> = [];
    for (const calendar of calendars.data) {
      if (next.has(calendar.id)) {
        selected.push({ id: calendar.id, summary: calendar.summary });
      }
    }
    save.mutate(
      { projectId, calendars: selected },
      {
        onSuccess: () => {
          setPendingChecked(null);
        },
        onError: (e) => {
          setPendingChecked(null);
          onToast(String(e));
        },
      },
    );
  };

  return (
    <div className="border-border flex flex-col gap-2 border-t px-4 py-3">
      <SectionLabel>포함할 캘린더</SectionLabel>
      <p className="text-muted-foreground -mt-1 text-xs leading-5">
        별(
        <Star className="inline size-3 align-[-1px]" />
        )을 누르면 타임라인에 카드를 놓을 때 자동으로 쓸 기본 캘린더가 됩니다 — 포함된 캘린더만
        지정할 수 있습니다.
      </p>
      {calendars.isLoading && <div className="text-muted-foreground text-sm">불러오는 중…</div>}
      {calendars.isError &&
        (() => {
          const msg = String(calendars.error);
          const isReconnect = msg.includes("재연결 필요");
          return (
            <div className="text-xs text-[color:var(--destructive)]">
              {isReconnect ? "재연결 필요 — Google 계정을 다시 연결하세요" : msg}
            </div>
          );
        })()}
      {calendars.data && calendars.data.length === 0 && (
        <div className="text-muted-foreground text-sm">캘린더가 없습니다.</div>
      )}
      {calendars.data?.map((c) => {
        const on = checked.has(c.id);
        const isDefault = on && defaultCalendarId === c.id;
        return (
          <div key={c.id} className="flex items-center gap-2.5 text-sm">
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggle(c.id)}
                className="sr-only"
                aria-label={`${c.summary} 포함`}
              />
              <span
                className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                  on ? "border-primary bg-primary text-primary-foreground" : "border-input"
                }`}
              >
                {on && <Check className="size-3" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{c.summary}</span>
              {c.primary && (
                <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[10px]">
                  Google 기본
                </span>
              )}
            </label>
            {on && (
              <button
                type="button"
                onClick={() => pickDefault(isDefault ? null : c.id)}
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors",
                  isDefault
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
                title={
                  isDefault
                    ? "타임라인 기본 캘린더 — 해제하려면 클릭"
                    : "타임라인에 놓을 때 쓸 기본 캘린더로 지정"
                }
                aria-pressed={isDefault}
                aria-label={`${c.summary} 타임라인 기본 캘린더`}
              >
                <Star className={cn("size-3", isDefault && "fill-current")} />
                {isDefault ? "기본" : "기본으로"}
              </button>
            )}
          </div>
        );
      })}
      {calendars.data && calendars.data.length > 0 && save.isPending && (
        <span className="text-muted-foreground mt-1 self-start text-xs">저장 중…</span>
      )}
    </div>
  );
}
