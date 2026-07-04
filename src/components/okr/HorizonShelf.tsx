import { Plus, Trash2 } from "lucide-react";
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
import { useCreateMissionHorizon, useDeleteMissionHorizon } from "@/lib/query";

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

export function HorizonShelf({ horizons }: { horizons: MissionHorizon[] }) {
  const createHorizon = useCreateMissionHorizon();
  const deleteHorizon = useDeleteMissionHorizon();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<MissionHorizonKind>("one_year");
  const [wsc, setWsc] = useState<WscKind>("w");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    await createHorizon.mutateAsync({
      title: cleanTitle,
      description: null,
      horizonKind: kind,
      wscKind: wsc,
      areaKeys: [],
      sortRank: horizons.length,
    });
    setTitle("");
  };

  return (
    <section className="mission-life-panel">
      <div className="mission-panel-head">
        <div>
          <h2 className="mission-panel-title typo-title-sm">Horizons</h2>
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
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => deleteHorizon.mutate(horizon.id)}
              disabled={deleteHorizon.isPending}
              aria-label={`${horizon.title} 삭제`}
            >
              <Trash2 className="size-4" />
            </Button>
          </article>
        ))}
        {horizons.length === 0 && (
          <div className="mission-empty-line typo-body-md">저장된 장기 방향이 없습니다.</div>
        )}
      </div>
      <form className="mission-horizon-form" onSubmit={submit}>
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="장기 방향 또는 1년 테마"
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
        <Select value={wsc} onValueChange={(value) => setWsc(value as WscKind)}>
          <SelectTrigger className="mission-wsc-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="w">W</SelectItem>
            <SelectItem value="s">S</SelectItem>
            <SelectItem value="c">C</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" disabled={createHorizon.isPending || title.trim().length === 0}>
          <Plus className="size-4" />
          추가
        </Button>
      </form>
    </section>
  );
}
