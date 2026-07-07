import { Pencil, Plus, Trash2, X } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { MissionHorizon, MissionHorizonKind, WscKind } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useCreateMissionHorizon,
  useDeleteMissionHorizon,
  useUpdateMissionHorizon,
} from "@/lib/query";

const HORIZON_KIND_LABEL: Record<MissionHorizonKind, string> = {
  three_year: "3년 방향",
  one_year: "1년 테마",
  someday: "언젠가",
};

const WSC_LABEL: Record<WscKind, string> = {
  w: "W",
  s: "S",
  c: "C",
};

const WSC_NONE = "__none__";
type WscDraft = WscKind | typeof WSC_NONE;

export function HorizonShelf({ horizons }: { horizons: MissionHorizon[] }) {
  const createHorizon = useCreateMissionHorizon();
  const updateHorizon = useUpdateMissionHorizon();
  const deleteHorizon = useDeleteMissionHorizon();
  const [editing, setEditing] = useState<MissionHorizon | null>(null);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<MissionHorizonKind>("one_year");
  const [wsc, setWsc] = useState<WscDraft>("w");

  const resetForm = () => {
    setEditing(null);
    setTitle("");
    setKind("one_year");
    setWsc("w");
  };

  const beginEdit = (horizon: MissionHorizon) => {
    setEditing(horizon);
    setTitle(horizon.title);
    setKind(horizon.horizonKind);
    setWsc(horizon.wscKind ?? WSC_NONE);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    if (editing) {
      await updateHorizon.mutateAsync({
        id: editing.id,
        title: cleanTitle,
        description: editing.description,
        horizonKind: kind,
        wscKind: wsc === WSC_NONE ? null : wsc,
        areaKeys: editing.areaKeys,
        status: editing.status,
        sortRank: editing.sortRank,
      });
    } else {
      await createHorizon.mutateAsync({
        title: cleanTitle,
        description: null,
        horizonKind: kind,
        wscKind: wsc === WSC_NONE ? null : wsc,
        areaKeys: [],
        sortRank: horizons.length,
      });
    }
    resetForm();
  };

  const pending = createHorizon.isPending || updateHorizon.isPending || deleteHorizon.isPending;

  return (
    <section className="mission-life-panel">
      <div className="mission-panel-head">
        <div>
          <h2 className="mission-panel-title typo-title-sm">장기 목표</h2>
        </div>
      </div>
      <div className="mission-horizon-list">
        {horizons.map((horizon) => (
          <article key={horizon.id} className="mission-horizon-item">
            <div>
              <span className="mission-horizon-meta typo-mono-label">
                {HORIZON_KIND_LABEL[horizon.horizonKind]} ·{" "}
                {horizon.wscKind ? WSC_LABEL[horizon.wscKind] : "태그 없음"}
              </span>
              <strong className="typo-body-strong">{horizon.title}</strong>
            </div>
            <div className="mission-row-actions">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mission-row-action"
                onClick={() => beginEdit(horizon)}
                disabled={pending}
                aria-label={`${horizon.title} 수정`}
              >
                <Pencil className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mission-row-action mission-row-action-danger"
                onClick={() => deleteHorizon.mutate(horizon.id)}
                disabled={pending}
                aria-label={`${horizon.title} 삭제`}
              >
                <Trash2 className="size-5" />
              </Button>
            </div>
          </article>
        ))}
        {horizons.length === 0 && (
          <div className="mission-empty-line typo-body-md">저장된 장기 목표가 없습니다.</div>
        )}
      </div>
      <form className="mission-horizon-form" onSubmit={submit}>
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="장기 목표 또는 1년 테마"
        />
        <Select value={kind} onValueChange={(value) => setKind(value as MissionHorizonKind)}>
          <SelectTrigger className="mission-horizon-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="three_year">3년</SelectItem>
            <SelectItem value="one_year">1년</SelectItem>
            <SelectItem value="someday">언젠가</SelectItem>
          </SelectContent>
        </Select>
        <Select value={wsc} onValueChange={(value) => setWsc(value as WscDraft)}>
          <SelectTrigger className="mission-wsc-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={WSC_NONE}>없음</SelectItem>
            <SelectItem value="w">W</SelectItem>
            <SelectItem value="s">S</SelectItem>
            <SelectItem value="c">C</SelectItem>
          </SelectContent>
        </Select>
        <div className="mission-form-actions">
          {editing && (
            <Button type="button" variant="ghost" size="sm" onClick={resetForm} disabled={pending}>
              <X className="size-4" />
              취소
            </Button>
          )}
          <Button type="submit" disabled={pending || title.trim().length === 0}>
            <Plus className="size-4" />
            {editing ? "저장" : "추가"}
          </Button>
        </div>
      </form>
    </section>
  );
}
