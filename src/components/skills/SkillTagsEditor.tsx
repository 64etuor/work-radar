import { X } from "lucide-react";
import { useState } from "react";

import type { Skill } from "@/bindings";
import { useSetSkillTags } from "@/lib/query";

/** 스킬 태그 편집기(인앱/외부 공통 — Sheet 안). 칩 클릭=제거, 입력+Enter=추가. set 의미로 전체 교체.
 * 외부 스킬도 태그 가능(로컬 SQLite만 — 디스크 파일 무변경). 사람 태깅 전용(#1 — 자동 분류 없음). */
export function SkillTagsEditor({ skill }: { skill: Skill }) {
  const setTags = useSetSkillTags();
  const [input, setInput] = useState("");
  const tags = skill.tags;

  const commit = (next: string[]) => {
    if (setTags.isPending) return;
    setTags.mutate({ skillKey: skill.id, tags: next });
  };
  const add = () => {
    const t = input.trim();
    setInput("");
    if (!t || tags.includes(t)) return;
    commit([...tags, t]);
  };
  const remove = (t: string) => commit(tags.filter((x) => x !== t));

  return (
    <div className="skl-tags-edit">
      <span className="skl-tags-label">태그</span>
      <div className="skl-tags-chips">
        {tags.map((t) => (
          <button
            key={t}
            type="button"
            className="skl-tag-chip"
            onClick={() => remove(t)}
            aria-label={`태그 ${t} 제거`}
          >
            {t}
            <X className="size-3" />
          </button>
        ))}
        <input
          className="skl-tag-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="태그 추가"
          aria-label="태그 추가"
        />
      </div>
    </div>
  );
}
