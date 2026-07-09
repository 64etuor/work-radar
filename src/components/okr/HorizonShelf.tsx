import { Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { MissionHorizon, MissionHorizonKind } from "@/bindings";
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

import { DraftInput } from "./DraftInput";

const HORIZON_KIND_LABEL: Record<MissionHorizonKind, string> = {
  three_year: "3년 방향",
  one_year: "1년 테마",
  someday: "언젠가",
};

export function HorizonShelf({ horizons }: { horizons: MissionHorizon[] }) {
  const createHorizon = useCreateMissionHorizon();
  const updateHorizon = useUpdateMissionHorizon();
  const deleteHorizon = useDeleteMissionHorizon();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<MissionHorizonKind>("one_year");

  const resetForm = () => {
    setTitle("");
    setKind("one_year");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    await createHorizon.mutateAsync({
      title: cleanTitle,
      description: null,
      horizonKind: kind,
      wscKind: null,
      areaKeys: [],
      sortRank: horizons.length,
    });
    resetForm();
  };

  const pending = createHorizon.isPending || updateHorizon.isPending || deleteHorizon.isPending;

  const patch = (horizon: MissionHorizon, partial: Partial<MissionHorizon>) =>
    void updateHorizon.mutateAsync({
      id: horizon.id,
      title: horizon.title,
      description: horizon.description,
      horizonKind: horizon.horizonKind,
      wscKind: horizon.wscKind,
      areaKeys: horizon.areaKeys,
      status: horizon.status,
      sortRank: horizon.sortRank,
      ...partial,
    });

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
            <div className="mission-inline-editor">
              <DraftInput
                className="mission-foundation-title"
                value={horizon.title}
                disabled={pending}
                onCommit={(next) => {
                  const clean = next.trim();
                  if (clean && clean !== horizon.title) patch(horizon, { title: clean });
                }}
                aria-label={`장기 목표 제목: ${horizon.title}`}
              />
              <Select
                value={horizon.horizonKind}
                onValueChange={(value) =>
                  patch(horizon, { horizonKind: value as MissionHorizonKind })
                }
                disabled={pending}
              >
                <SelectTrigger
                  className="mission-inline-period"
                  aria-label={`${horizon.title} 기간`}
                >
                  <SelectValue aria-label={HORIZON_KIND_LABEL[horizon.horizonKind]} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="three_year">3년</SelectItem>
                  <SelectItem value="one_year">1년</SelectItem>
                  <SelectItem value="someday">언젠가</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="mission-row-actions">
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
        <div className="mission-form-actions">
          <Button type="submit" disabled={pending || title.trim().length === 0}>
            <Plus className="size-4" />
            추가
          </Button>
        </div>
      </form>
    </section>
  );
}
