import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";

import type { ProjectKind } from "@/bindings";
import { useCreateProject } from "@/lib/query";
import { trimOrNull } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Field, Segmented } from "./kit";

/**
 * Add Project 폼 — 개인/업무 + Notion DB 바인딩.
 * 토큰은 여기서 받지 않는다 — 프로젝트 생성 후 ProjectCard의 CLI 가져오기/keychain으로.
 */
export function AddProjectForm({
  autoFocus,
  onCreated,
}: {
  autoFocus?: boolean;
  onCreated?: (msg: string) => void;
}) {
  const create = useCreateProject();
  const nameRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [kind, setKind] = useState<ProjectKind>("work");
  const [backlogDb, setBacklogDb] = useState("");
  const [agendaDb, setAgendaDb] = useState("");

  useEffect(() => {
    if (autoFocus) nameRef.current?.focus();
  }, [autoFocus]);

  const submit = () => {
    if (!name.trim() || create.isPending) return;
    create.mutate(
      {
        name: name.trim(),
        kind,
        notionBacklogDbId: trimOrNull(backlogDb),
        notionAgendaDbId: trimOrNull(agendaDb),
      },
      {
        onSuccess: (p) => {
          setName("");
          setBacklogDb("");
          setAgendaDb("");
          onCreated?.(`프로젝트 "${p.name}" 추가`);
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>새 프로젝트</CardTitle>
        <CardDescription>
          개인 또는 업무 프로젝트를 추가하고 Notion DB를 연결하세요.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <Field label="이름" htmlFor="new-project-name">
          <Input
            id="new-project-name"
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="예: Mirrorless / 내 삶"
          />
        </Field>

        <Field label="종류">
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: "personal", label: "개인" },
              { value: "work", label: "업무" },
            ]}
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Notion 백로그 DB ID" hint="선택 — 백로그 미러링 대상">
            <Input
              value={backlogDb}
              onChange={(e) => setBacklogDb(e.target.value)}
              placeholder="데이터베이스 ID"
              className="font-mono"
            />
          </Field>
          <Field label="Notion 안건 DB ID" hint="선택 — 안건/회의 미러링 대상">
            <Input
              value={agendaDb}
              onChange={(e) => setAgendaDb(e.target.value)}
              placeholder="데이터베이스 ID"
              className="font-mono"
            />
          </Field>
        </div>

        {create.isError && (
          <div className="text-sm text-[color:var(--destructive)]">
            {String(create.error)}
          </div>
        )}
      </CardContent>

      <CardFooter className="justify-end">
        <Button onClick={submit} disabled={!name.trim() || create.isPending}>
          <Plus className="size-4" />
          {create.isPending ? "추가 중…" : "프로젝트 추가"}
        </Button>
      </CardFooter>
    </Card>
  );
}
