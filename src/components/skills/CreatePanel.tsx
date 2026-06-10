import { Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCreateSkill } from "@/lib/query";

/** radix Select는 빈 문자열 value를 금지 → "미바인딩"을 센티넬로 표현(write 시 빈 문자열로 정규화). */
const BIND_NONE = "__none__";

/** 인앱 프롬프트 추가 패널. binding은 닫힌 세트(또는 미바인딩). */
export function CreatePanel({ onDone }: { onDone: (id: string | null) => void }) {
  const create = useCreateSkill();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [binding, setBinding] = useState<string>("");
  const [note, setNote] = useState<string | null>(null);

  const submit = () => {
    if (create.isPending) return;
    setNote(null);
    create.mutate(
      { name, prompt, binding: binding || null },
      {
        onSuccess: (s) => onDone(s.id),
        onError: (e) => setNote(`추가 실패: ${(e as Error).message}`),
      },
    );
  };

  return (
    <div className="skl-edit">
      <div className="skl-edit-top">
        <Input
          className="flex-1 font-semibold"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="스킬 이름"
          aria-label="새 스킬 이름"
        />
        <Select
          value={binding || BIND_NONE}
          onValueChange={(v) => setBinding(v === BIND_NONE ? "" : v)}
        >
          <SelectTrigger className="w-auto min-w-[140px] font-mono" aria-label="잡 바인딩">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={BIND_NONE}>미바인딩</SelectItem>
            <SelectItem value="enrich">enrich</SelectItem>
            <SelectItem value="batch_enrich">batch_enrich</SelectItem>
            <SelectItem value="ci_triage">ci_triage</SelectItem>
            <SelectItem value="pr_selfcheck">pr_selfcheck</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Textarea
        className="min-h-[320px] resize-y font-mono leading-relaxed"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="프롬프트 템플릿…"
        spellCheck={false}
        aria-label="새 프롬프트 템플릿"
      />
      <div className="skl-actions">
        <Button
          className="gap-1.5 rounded-full"
          onClick={submit}
          disabled={!name.trim() || !prompt.trim() || create.isPending}
        >
          <Plus className="size-4" />
          {create.isPending ? "추가 중…" : "추가"}
        </Button>
        <Button variant="outline" className="rounded-full" onClick={() => onDone(null)}>
          취소
        </Button>
        {note && <span className="skl-note">{note}</span>}
      </div>
    </div>
  );
}
