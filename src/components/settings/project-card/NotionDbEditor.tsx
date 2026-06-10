import { useState } from "react";

import type { Project, PromotionTarget } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSetProjectNotionDbIds, useTestNotionConnection } from "@/lib/query";
import { trimOrNull } from "@/lib/utils";

import { Field, SectionLabel } from "../SettingsKit";

/** Notion DB 연결 테스트 버튼 + 인라인 결과. */
function NotionDbTestButton({
  projectId,
  target,
  dbId,
}: {
  projectId: string;
  target: PromotionTarget;
  dbId: string;
}) {
  const test = useTestNotionConnection();
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const run = () => {
    setResult(null);
    test.mutate(
      { projectId, target },
      {
        onSuccess: (msg) => setResult({ ok: true, msg }),
        onError: (e) => setResult({ ok: false, msg: String(e) }),
      },
    );
  };

  return (
    <div className="border-border rounded-lg border px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">
          {target === "notion_backlog" ? "백로그 DB" : "안건 DB"}
        </span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
          {dbId}
        </span>
        <Button variant="outline" size="sm" onClick={run} disabled={test.isPending}>
          {test.isPending ? "테스트 중…" : "연결 테스트"}
        </Button>
      </div>
      {result && (
        <div
          className={`mt-2 text-xs ${
            result.ok ? "text-[color:var(--success)]" : "text-[color:var(--destructive)]"
          }`}
        >
          {result.msg}
        </div>
      )}
    </div>
  );
}

/**
 * Notion DB 바인딩 편집기: 백로그/안건 DB ID를 생성 후에도 변경/오타 수정/해제할 수 있다.
 * 빈 값 저장 = 연결 해제. 저장 시 토큰이 있으면 백엔드가 라이브 접근 검증한다. 저장된 ID는 아래
 * "연결 테스트"로 확인. (이전엔 생성 시 1회 바인딩 후 수정 경로가 없어 오타 시 프로젝트 재생성이
 * 유일한 해결책이었다.)
 */
export function NotionDbEditor({
  project,
  onToast,
}: {
  project: Project;
  onToast: (msg: string) => void;
}) {
  const save = useSetProjectNotionDbIds();
  const [backlog, setBacklog] = useState(project.notionBacklogDbId ?? "");
  const [agenda, setAgenda] = useState(project.notionAgendaDbId ?? "");

  // 서버 값이 바뀌면(저장 성공 등) 드래프트 재시드 — 두 필드를 JSON 배열 키로 합쳐 단일 비교(구분자 충돌/제어문자 없음).
  const serverKey = JSON.stringify([project.notionBacklogDbId, project.notionAgendaDbId]);
  const [seeded, setSeeded] = useState(serverKey);
  if (serverKey !== seeded) {
    setSeeded(serverKey);
    setBacklog(project.notionBacklogDbId ?? "");
    setAgenda(project.notionAgendaDbId ?? "");
  }

  const dirty =
    (trimOrNull(backlog) ?? "") !== (project.notionBacklogDbId ?? "") ||
    (trimOrNull(agenda) ?? "") !== (project.notionAgendaDbId ?? "");

  const submit = () => {
    if (!dirty || save.isPending) return;
    save.mutate(
      {
        projectId: project.id,
        backlogDbId: trimOrNull(backlog),
        agendaDbId: trimOrNull(agenda),
      },
      {
        onSuccess: () => onToast("Notion DB 연결 저장됨"),
        onError: () => onToast("Notion DB 저장 실패"),
      },
    );
  };

  return (
    <div className="border-border bg-muted/15 flex flex-col gap-2.5 rounded-xl border p-4">
      <SectionLabel>Notion DB 연결</SectionLabel>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="백로그 DB ID" hint="비우면 연결 해제">
          <Input
            value={backlog}
            onChange={(e) => setBacklog(e.target.value)}
            placeholder="데이터베이스 ID/URL"
            className="font-mono"
          />
        </Field>
        <Field label="안건 DB ID" hint="비우면 연결 해제">
          <Input
            value={agenda}
            onChange={(e) => setAgenda(e.target.value)}
            placeholder="데이터베이스 ID/URL"
            className="font-mono"
          />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={!dirty || save.isPending}>
          {save.isPending ? "저장 중…" : "저장"}
        </Button>
      </div>
      {save.isError && (
        <div className="text-xs text-[color:var(--destructive)]">{String(save.error)}</div>
      )}
      {project.notionBacklogDbId && (
        <NotionDbTestButton
          projectId={project.id}
          target="notion_backlog"
          dbId={project.notionBacklogDbId}
        />
      )}
      {project.notionAgendaDbId && (
        <NotionDbTestButton
          projectId={project.id}
          target="notion_agenda"
          dbId={project.notionAgendaDbId}
        />
      )}
    </div>
  );
}
