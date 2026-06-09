import { useMemo } from "react";

import type { Kind } from "@/bindings";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDefaultWriteCalendars, useProjects, useSetDefaultWriteCalendar } from "@/lib/query";
import { routineSyncCandidates } from "@/lib/routineSync";

import { SectionLabel } from "./SettingsKit";

/** Radix Select는 빈 문자열 value를 예약 — "기본 없음"은 sentinel로 표현 후 null로 매핑. */
const NONE = "__none__";

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "personal", label: "개인" },
  { kind: "work", label: "업무" },
];

/**
 * 타임라인 kind별 기본 캘린더 설정(전역). 미배치 카드를 타임라인에 놓을 때 프로젝트
 * `default_write_calendar_id`가 없으면 여기서 고른 캘린더로 자동 라우팅된다(개인/업무 각각).
 * 후보 = 해당 kind 프로젝트들이 선택한 Google 캘린더(routineSyncCandidates, 네트워크 없음).
 */
export function TimelineCalendarDefaults({ onToast }: { onToast: (msg: string) => void }) {
  const projects = useProjects();
  const defaults = useDefaultWriteCalendars();
  const setDefault = useSetDefaultWriteCalendar();
  const list = projects.data ?? [];

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <SectionLabel>타임라인 기본 캘린더</SectionLabel>
        <p className="text-muted-foreground mt-1 text-sm leading-6">
          미배치 카드를 타임라인에 놓을 때, 프로젝트 기본 캘린더가 없으면 개인·업무 각각 여기서 고른
          캘린더로 자동 반영됩니다. "기본 없음"이면 놓을 때마다 직접 고릅니다.
        </p>
      </div>
      {KINDS.map(({ kind, label }) => (
        <KindDefaultRow
          key={kind}
          label={label}
          candidates={routineSyncCandidates(list, kind)}
          current={
            kind === "personal" ? (defaults.data?.personal ?? null) : (defaults.data?.work ?? null)
          }
          onChange={(calendarId) =>
            setDefault.mutate(
              { kind, calendarId },
              {
                onSuccess: () =>
                  onToast(`${label} 기본 캘린더 ${calendarId ? "저장됨" : "해제됨"}`),
                onError: () => onToast(`${label} 기본 캘린더 저장 실패`),
              },
            )
          }
        />
      ))}
    </Card>
  );
}

function KindDefaultRow({
  label,
  candidates,
  current,
  onChange,
}: {
  label: string;
  candidates: { id: string; summary: string | null }[];
  current: string | null;
  onChange: (calendarId: string | null) => void;
}) {
  // 저장된 값이 후보 목록에 없으면(프로젝트가 캘린더를 뺀 경우 등) 원문 id로라도 노출해
  // 선택 상태를 잃지 않는다.
  const options = useMemo(() => {
    if (current && !candidates.some((c) => c.id === current)) {
      return [{ id: current, summary: current }, ...candidates];
    }
    return candidates;
  }, [candidates, current]);

  const value = current ?? NONE;
  const empty = options.length === 0;

  return (
    <label className="flex items-center gap-3">
      <span className="w-12 shrink-0 text-sm font-medium">{label}</span>
      <Select value={value} onValueChange={(v) => onChange(v === NONE ? null : v)} disabled={empty}>
        <SelectTrigger className="max-w-sm flex-1" aria-label={`${label} 기본 캘린더`}>
          <SelectValue
            placeholder={empty ? `${label} 프로젝트 캘린더 없음` : "기본 없음 (매번 선택)"}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>기본 없음 (매번 선택)</SelectItem>
          {options.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.summary || c.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
