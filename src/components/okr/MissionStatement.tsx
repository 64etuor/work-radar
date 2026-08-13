import { Edit3 } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";

import type { Mission } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useSetMission } from "@/lib/query";

const MISSION_PLACEHOLDER = "이번 시즌 내가 지키려는 방향을 한 문장으로 적어두세요.";

/**
 * 미션 문구 인라인 편집 — 표시 span과 동일 타이포의 제로 크롬 textarea(레이아웃 시프트 0).
 * 미설정이면 빈 값 + placeholder(문구를 지우고 타이핑하게 만들지 않는다).
 */
export function MissionStatement({ mission }: { mission: Mission | null }) {
  const setMission = useSetMission();
  const savedStatement = mission?.statement ?? "";
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useState(savedStatement);
  const submittingRef = useRef(false);

  const cancel = () => {
    setStatement(savedStatement);
    setEditing(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanStatement = statement.trim();
    if (!cleanStatement || submittingRef.current) return;
    submittingRef.current = true;
    try {
      await setMission.mutateAsync({ statement: cleanStatement, note: mission?.note ?? null });
      setEditing(false);
    } finally {
      submittingRef.current = false;
    }
  };

  if (editing) {
    return (
      <form className="mission-statement-form" onSubmit={submit}>
        <Textarea
          value={statement}
          placeholder={MISSION_PLACEHOLDER}
          onChange={(event) => setStatement(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
          }}
          rows={1}
          autoFocus
        />
        <div className="mission-statement-actions">
          <Button type="button" variant="outline" size="sm" onClick={cancel}>
            취소
          </Button>
          <Button type="submit" size="sm" disabled={setMission.isPending || !statement.trim()}>
            저장
          </Button>
        </div>
      </form>
    );
  }

  return (
    <button type="button" className="mission-statement" onClick={() => setEditing(true)}>
      <span className="typo-title-md" data-placeholder={savedStatement ? undefined : ""}>
        {savedStatement || MISSION_PLACEHOLDER}
      </span>
      <Edit3 className="size-5" aria-hidden="true" />
    </button>
  );
}
