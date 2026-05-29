import { Pencil, Trash2 } from "lucide-react";
import { useId, useState } from "react";

import type {
  Kind,
  LifeWheelTagConfig,
  Project,
  RoutineFreq,
  RoutineToday,
  Weekday,
} from "@/bindings";
import { CheckIcon } from "@/components/board/CheckIcon";
import { AreaRadialPalette, CardTagEditor } from "@/components/board/LifeWheelPalette";
import { RoutineSyncButton } from "@/components/board/RoutineSyncButton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/input";
import { useListReorder } from "@/lib/useListReorder";

// 매 렌더 새 JSX 노드 할당 방지(react-doctor/jsx-no-jsx-as-prop) — props/closure가 없는 정적 SVG.
const CHECK_INDICATOR = <CheckIcon />;

/** 루틴 생성 입력(폼 → CaptureBoard). kind/area는 카드에서 즉시 갱신(IPC)되므로 폼은 안 받는다. */
export type RoutineDraft = {
  title: string;
  freq: RoutineFreq;
  weekdays: Weekday[];
  anchorDate: string | null;
  timeOfDay: string | null;
  reminderOffsetMin: number | null;
};

type Props = {
  routines: RoutineToday[];
  lifeWheelTags: LifeWheelTagConfig[];
  /** Google 캘린더 동기화 picker 후보 산출용(루틴 kind와 같은 kind 프로젝트의 선택 캘린더). */
  projects: Project[];
  onToggle: (routineId: string, done: boolean) => void;
  onCreate: (draft: RoutineDraft) => void;
  onUpdate: (id: string, draft: RoutineDraft) => void;
  onDelete: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onOpenTracking: () => void;
  /** 루틴 personal/work 즉시 갱신(signals와 동일 패턴). */
  onSetKind: (id: string, kind: Kind | null) => void;
  /** Life Wheel tag 단일 선택(커스텀 키 허용). */
  onSetAreaTagKey: (id: string, tagKey: string | null) => void;
  /** Google 동기화 ON(kind 일치 프로젝트 + 캘린더). */
  onEnableSync: (routineId: string, projectId: string, calendarId: string) => void;
  /** Google 동기화 OFF. */
  onDisableSync: (routineId: string) => void;
  /** 동기화 mutation 진행 중(중복 클릭 방지). */
  syncBusy?: boolean;
};

const DAYS: { label: string; key: Weekday }[] = [
  { label: "월", key: "mon" },
  { label: "화", key: "tue" },
  { label: "수", key: "wed" },
  { label: "목", key: "thu" },
  { label: "금", key: "fri" },
  { label: "토", key: "sat" },
  { label: "일", key: "sun" },
];

const FREQS: { value: RoutineFreq; label: string }[] = [
  { value: "daily", label: "매일" },
  { value: "weekly", label: "매주" },
  { value: "biweekly", label: "격주" },
  { value: "monthly", label: "매월" },
];

function schedLabel(r: RoutineToday): string {
  if (r.freq === "daily") return "매일";
  if (r.freq === "monthly") {
    const day = r.anchorDate ? Number(r.anchorDate.split("-")[2]) : null;
    return day ? `매월 ${day}일` : "매월";
  }
  const order = DAYS.map((d) => d.key);
  const days = r.weekdays
    .slice()
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((w) => DAYS.find((d) => d.key === w)?.label ?? w)
    .join("·");
  return r.freq === "biweekly" ? `격주 ${days}` : days;
}

/** 우측 하단 Routines 패널 — 오늘 해당 반복 작업 체크리스트 + 추가 폼 + 드래그 정렬. */
export function RoutinesPanel({
  routines,
  lifeWheelTags,
  projects,
  onToggle,
  onCreate,
  onUpdate,
  onDelete,
  onReorder,
  onOpenTracking,
  onSetKind,
  onSetAreaTagKey,
  onEnableSync,
  onDisableSync,
  syncBusy,
}: Props) {
  // open=false: 폼 닫힘. open=true + editId=null: 새 루틴 추가. open=true + editId: 수정 모드.
  const fieldId = useId();
  const timeId = `${fieldId}-time`;
  const offsetId = `${fieldId}-offset`;

  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [freq, setFreq] = useState<RoutineFreq>("daily");
  const [days, setDays] = useState<Set<Weekday>>(new Set());
  const [time, setTime] = useState("");
  const [offset, setOffset] = useState("");
  // BrainDump 카드와 동일하게 area 방사형 휠을 위한 anchor 상태(panel 내 자체 소유).
  const [areaPalette, setAreaPalette] = useState<{
    routineId: string;
    x: number;
    y: number;
  } | null>(null);

  const dnd = useListReorder(
    routines.map((r) => r.id),
    onReorder,
  );

  // 요일 입력은 weekly/biweekly에서만, day-of-month(anchor)는 monthly에서 오늘로 자동.
  const needsWeekdays = freq === "weekly" || freq === "biweekly";

  const toggleDay = (key: Weekday) => {
    setDays((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const reset = () => {
    setTitle("");
    setFreq("daily");
    setDays(new Set());
    setTime("");
    setOffset("");
    setEditId(null);
  };

  const openCreate = () => {
    reset();
    setOpen(true);
  };

  const openEdit = (r: RoutineToday) => {
    setEditId(r.id);
    setTitle(r.title);
    setFreq(r.freq);
    setDays(new Set(r.weekdays));
    setTime(r.timeOfDay ?? "");
    setOffset(r.reminderOffsetMin != null ? String(r.reminderOffsetMin) : "");
    setOpen(true);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    if (needsWeekdays && days.size === 0) return; // weekly/biweekly는 요일 필수.
    const weekdays = needsWeekdays ? DAYS.filter((d) => days.has(d.key)).map((d) => d.key) : [];
    const offNum = offset.trim() === "" ? null : Math.max(0, Number(offset));
    const draft: RoutineDraft = {
      title: t,
      freq,
      weekdays,
      // biweekly/monthly anchor는 백엔드가 기존 값 또는 오늘로 채운다(폼은 비워 보낸다).
      anchorDate: null,
      timeOfDay: time.trim() === "" ? null : time,
      reminderOffsetMin: Number.isFinite(offNum as number) ? offNum : null,
    };
    if (editId) {
      onUpdate(editId, draft);
    } else {
      onCreate(draft);
    }
    reset();
    setOpen(false);
  };

  const handleDelete = (r: RoutineToday) => {
    if (!window.confirm(`"${r.title}" 루틴을 삭제할까요?`)) return;
    onDelete(r.id);
  };

  return (
    <div className="panelbox">
      <div className="pb-head">
        <span className="lbl">Routines</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 rounded-full px-2.5 text-[11px]"
          onClick={onOpenTracking}
          title="루틴 트래킹"
        >
          트래킹
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 rounded-full px-2.5 text-[11px]"
          onClick={openCreate}
        >
          + 루틴
        </Button>
      </div>

      {open && (
        <form className="rform" onSubmit={submit}>
          <Input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="루틴 제목 (예: 아침 운동)"
            autoComplete="off"
            data-cb-routine-title
            autoFocus
            className="mb-1.5 h-8 text-[13px]"
          />
          <div className="rfreqs">
            {FREQS.map((f) => (
              <Button
                key={f.value}
                type="button"
                variant={freq === f.value ? "default" : "outline"}
                size="sm"
                aria-pressed={freq === f.value}
                className="flex-1 text-[11px]"
                onClick={() => setFreq(f.value)}
              >
                {f.label}
              </Button>
            ))}
          </div>
          {needsWeekdays && (
            <div className="days">
              {DAYS.map((d) => (
                <Button
                  key={d.key}
                  type="button"
                  variant={days.has(d.key) ? "default" : "outline"}
                  size="sm"
                  aria-pressed={days.has(d.key)}
                  className="size-[26px] p-0 text-[11px]"
                  onClick={() => toggleDay(d.key)}
                >
                  {d.label}
                </Button>
              ))}
            </div>
          )}
          {freq === "monthly" && (
            <div className="rhint">오늘 날짜를 매월 기준일로 사용합니다 (월말 자동 보정).</div>
          )}
          {freq === "biweekly" && (
            <div className="rhint">이번 주를 기준으로 2주마다 반복합니다.</div>
          )}
          <div className="rtime">
            <label htmlFor={timeId}>
              시간
              <Input
                id={timeId}
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="h-8 w-auto px-2 text-xs"
              />
            </label>
            <label htmlFor={offsetId}>
              알림
              <span className="roff">
                <Input
                  id={offsetId}
                  type="number"
                  min={0}
                  value={offset}
                  onChange={(e) => setOffset(e.target.value)}
                  placeholder="0"
                  disabled={time.trim() === ""}
                  className="h-8 w-12 px-2 text-xs"
                />
                분 전
              </span>
            </label>
          </div>
          <div className="row">
            <Button type="submit" size="sm" className="rounded-full px-3.5 text-xs">
              {editId ? "저장" : "추가"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-full px-3.5 text-xs"
              onClick={() => {
                reset();
                setOpen(false);
              }}
            >
              취소
            </Button>
          </div>
        </form>
      )}

      <div className="pb-body">
        {routines.length === 0 ? (
          <div className="empty">오늘 해당하는 루틴이 없습니다. + 루틴으로 추가</div>
        ) : (
          routines.map((r) => (
            <div key={r.id} className={cn("item", r.done && "done")} {...dnd.itemProps(r.id)}>
              <span className="grip" title="드래그로 정렬" {...dnd.handleProps(r.id)}>
                ⠿
              </span>
              <Checkbox
                className="cb-check"
                checked={r.done}
                onCheckedChange={(v) => onToggle(r.id, v === true)}
                aria-label={r.done ? "완료 해제" : "완료"}
                forceMountIndicator
                indicator={CHECK_INDICATOR}
              />
              <div className="body">
                <div className="ttl">{r.title}</div>
                <div className="meta">
                  <span className="badge b-sched">{schedLabel(r)}</span>
                  {r.timeOfDay && <span className="badge b-time">{r.timeOfDay}</span>}
                  <CardTagEditor
                    target={r}
                    tags={lifeWheelTags}
                    onSetKind={onSetKind}
                    onOpenAreaPalette={(button) => {
                      const rect = button.getBoundingClientRect();
                      setAreaPalette({
                        routineId: r.id,
                        x: rect.left + rect.width / 2,
                        y: rect.top + rect.height / 2,
                      });
                    }}
                  />
                </div>
              </div>
              <div className="ractions">
                <RoutineSyncButton
                  routine={r}
                  projects={projects}
                  onEnable={onEnableSync}
                  onDisable={onDisableSync}
                  busy={syncBusy}
                />
                <button
                  type="button"
                  className="ract"
                  title="수정"
                  aria-label="루틴 수정"
                  onClick={() => openEdit(r)}
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  className="ract danger"
                  title="삭제"
                  aria-label="루틴 삭제"
                  onClick={() => handleDelete(r)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      {areaPalette &&
        (() => {
          const target = routines.find((r) => r.id === areaPalette.routineId);
          if (!target) return null;
          return (
            <AreaRadialPalette
              target={target}
              tags={lifeWheelTags.filter((tag) => tag.enabled)}
              anchor={{ x: areaPalette.x, y: areaPalette.y }}
              onClose={() => setAreaPalette(null)}
              onSetAreaTagKey={onSetAreaTagKey}
            />
          );
        })()}
    </div>
  );
}
