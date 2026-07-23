import { BookOpen } from "lucide-react";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAladinTtbStatus, useSetAladinTtbKey } from "@/lib/query";

import { StatusDot } from "./SettingsKit";

/**
 * 독서 카탈로그 — 알라딘 TTB 키. 키가 있으면 책 검색이 알라딘(국내 서지 최적)을 우선한다.
 * INVARIANT: 키 평문은 로컬 입력 상태에만 잠시 머물고, 저장(IPC) 직후 비운다(재표시 없음).
 */
export function AladinTtbBlock({ onToast }: { onToast: (msg: string) => void }) {
  const { data: hasKey } = useAladinTtbStatus();
  const setKey = useSetAladinTtbKey();
  const [draft, setDraft] = useState("");

  const save = (e: FormEvent) => {
    e.preventDefault();
    const key = draft.trim();
    if (key.length === 0) return;
    setKey.mutate(key, {
      onSuccess: () => {
        setDraft("");
        onToast("알라딘 TTB 키를 저장했습니다 — 책 검색이 알라딘을 우선합니다.");
      },
    });
  };

  const clear = () => {
    setKey.mutate("", { onSuccess: () => onToast("알라딘 TTB 키를 해제했습니다.") });
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <span className="typo-body-strong inline-flex items-center gap-2">
          <BookOpen className="size-4" aria-hidden />
          알라딘 TTB (책 검색)
        </span>
        <StatusDot on={hasKey === true}>{hasKey ? "연결됨" : "미설정"}</StatusDot>
      </div>
      <p className="typo-body-md text-muted-foreground">
        국내 도서 서지는 알라딘이 가장 정확합니다. aladin.co.kr → TTB(오픈 API)에서 무료 키를
        발급받아 등록하면 독서 탭의 책 검색이 알라딘을 우선 사용합니다. 키는 OS 키체인에만
        저장됩니다.
      </p>
      <form className="flex items-center gap-2" onSubmit={save}>
        <Input
          type="password"
          placeholder="ttbxxxx...001"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoComplete="off"
        />
        <Button type="submit" size="sm" disabled={setKey.isPending || draft.trim() === ""}>
          저장
        </Button>
        {hasKey === true && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={clear}
            disabled={setKey.isPending}
          >
            해제
          </Button>
        )}
      </form>
    </Card>
  );
}
