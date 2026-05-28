import "./CalendarEventModal.css";

import { useState } from "react";

import type { Project, PromotionTarget } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** picker가 다룰 컨텍스트: 어느 카드를 어느 타깃으로 승격하며, 어떤 후보 중에서 고르는지. */
export type ProjectPickerState = {
  signalId: string;
  target: PromotionTarget;
  /** 토스트/제목용 라벨(예: "백로그 등록"). */
  label: string;
  /** 같은 kind의 후보 프로젝트(>1). 사람이 직접 고른다(INVARIANT #1 — 자동 확정 없음). */
  candidates: Project[];
};

type Props = {
  state: ProjectPickerState | null;
  onClose: () => void;
  /** 사람이 고른 프로젝트로 승격을 진행한다. */
  onPick: (projectId: string) => void;
};

/**
 * 여러 프로젝트가 같은 kind에 매칭될 때 사람이 라우팅 대상을 직접 고르는 모달.
 * window.prompt 대체(접근성·디자인 정합). INVARIANT #1: 자동 확정 없이 사람이 선택.
 * DESIGN.md(Cohere white editorial) — CalendarEventModal과 동일한 cev-* 토큰 재사용.
 */
export function ProjectPickerModal({ state, onClose, onPick }: Props) {
  const [selected, setSelected] = useState("");

  // 모달 열릴 때 첫 후보를 기본 선택 — prev-compare로 render에서 적용 (set-state-in-effect 회피).
  const [prevState, setPrevState] = useState(state);
  if (state !== prevState) {
    setPrevState(state);
    if (state) setSelected(state.candidates[0]?.id ?? "");
  }

  // Esc/외부 클릭/창 양보·포커스는 PR 0 Dialog 래퍼(overlay-stack 계약)가 전담(plan §0.6).

  if (!state) return null;

  const submit = () => {
    if (!selected) return;
    onPick(selected);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        showClose={false}
        aria-describedby={undefined}
        className="w-[min(440px,92vw)] max-w-none gap-3 p-5"
      >
        <DialogTitle className="font-mono text-[13px] font-semibold tracking-[0.1em] uppercase">
          프로젝트 선택 — {state.label}
        </DialogTitle>

        <label className="cev-field">
          <span className="cev-lbl">이 카드를 등록할 프로젝트</span>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger>
              <SelectValue placeholder="프로젝트 선택" />
            </SelectTrigger>
            <SelectContent>
              {state.candidates.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <div className="cev-actions">
          <Button variant="outline" className="rounded-full" onClick={onClose}>
            취소
          </Button>
          <Button className="rounded-full px-[22px]" onClick={submit} disabled={!selected}>
            등록
          </Button>
        </div>
        <div className="cev-hint">
          같은 영역에 프로젝트가 여럿이라 직접 선택합니다(자동 지정 안 함).
        </div>
      </DialogContent>
    </Dialog>
  );
}
