import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ProjectKind } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCreateProject } from "@/lib/query";
import { trimOrNull } from "@/lib/utils";

import { Field, SectionLabel, Segmented } from "./SettingsKit";

/**
 * Add Project 폼 — 개인/업무 + Notion DB 바인딩.
 * 토큰은 여기서 받지 않는다 — 프로젝트 생성 후 ProjectCard의 CLI 가져오기/keychain으로.
 */
export function AddProjectForm({
  autoFocus,
  onCreated,
}: {
  autoFocus?: boolean;
  onCreated?: (msg: string, projectId?: string) => void;
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
          onCreated?.(`프로젝트 "${p.name}" 추가`, p.id);
        },
      },
    );
  };

  return (
    <Card className="overflow-hidden rounded-2xl">
      <CardHeader className="border-border border-b p-5">
        <SectionLabel>프로젝트 추가</SectionLabel>
        {/* typo-title-md deferred here: shadcn CardTitle's base `text-base leading-none` sorts
            AFTER our @utility in the compiled cascade and would override it to 16px/lh-1. Migrate
            when CardTitle's base type is reconciled. See docs/areas/typography.md (incremental). */}
        <CardTitle className="mt-1 text-[17px] leading-tight tracking-[-0.01em]">
          새 프로젝트
        </CardTitle>
        <CardDescription className="max-w-[60ch] leading-6">
          개인 또는 업무 프로젝트를 추가하고 필요한 Notion DB를 선택적으로 연결하세요.
        </CardDescription>
      </CardHeader>

      <CardContent className="gap-5 pt-5">
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

        <Field label="종류" hint="분류는 표시와 필터에만 쓰이며 자동 결정을 만들지 않습니다.">
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: "personal", label: "개인" },
              { value: "work", label: "업무" },
            ]}
          />
        </Field>

        <div className="border-border bg-muted/15 grid grid-cols-1 gap-4 rounded-xl border p-4 sm:grid-cols-2">
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
          <div className="text-sm text-[color:var(--destructive)]">{String(create.error)}</div>
        )}
      </CardContent>

      <CardFooter className="bg-muted/10 justify-between">
        <span className="text-muted-foreground text-xs">
          토큰은 생성 후 keychain 섹션에서 연결합니다.
        </span>
        <Button onClick={submit} disabled={!name.trim() || create.isPending}>
          <Plus className="size-4" />
          {create.isPending ? "추가 중…" : "프로젝트 추가"}
        </Button>
      </CardFooter>
    </Card>
  );
}
