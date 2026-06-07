import { AlertTriangle, ShieldCheck } from "lucide-react";

import type { ConnCheck, ConnectionAudit, ConnState, ProjectConnectionStatus } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { useConnectionAudit } from "@/lib/query";

import { groupByKind, summarize } from "./connectionAudit";
import { SectionLabel } from "./SettingsKit";

const STATE_GLYPH: Record<ConnState, string> = {
  ok: "✓",
  failed: "✗",
  not_configured: "—",
};
const STATE_CLASS: Record<ConnState, string> = {
  ok: "text-[color:var(--success)]",
  failed: "text-[color:var(--destructive)]",
  not_configured: "text-muted-foreground",
};

/** 한 서비스 연결 칩. detail은 tooltip으로(토큰 본문 없음 — 식별자/에러만). */
function StateChip({ label, check }: { label: string; check: ConnCheck }) {
  return (
    <span
      className="border-border inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs"
      title={check.detail || label}
    >
      <span className={STATE_CLASS[check.state]}>{STATE_GLYPH[check.state]}</span>
      {label}
    </span>
  );
}

function ProjectRow({ p }: { p: ProjectConnectionStatus }) {
  return (
    <div className="border-border flex flex-col gap-1.5 rounded-lg border px-3 py-2.5">
      <span className="text-sm font-medium">{p.name}</span>
      <div className="flex flex-wrap gap-1.5">
        <StateChip label="GitHub" check={p.github} />
        <StateChip label="Notion" check={p.notion} />
        <StateChip label="백로그 DB" check={p.notionBacklogDb} />
        <StateChip label="안건 DB" check={p.notionAgendaDb} />
        <StateChip label="Google" check={p.googleCalendar} />
      </div>
    </div>
  );
}

function WarnRow({ text, strong }: { text: string; strong?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
        strong
          ? "border-[color:var(--destructive)] text-[color:var(--destructive)]"
          : "border-border text-foreground",
      )}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

function names(projects: { name: string }[]): string {
  return projects.map((p) => p.name).join(", ");
}

function Warnings({ audit }: { audit: ConnectionAudit }) {
  const { duplicates, environment } = audit;
  const total =
    duplicates.repos.length +
    duplicates.notionDbs.length +
    duplicates.accounts.length +
    environment.length;
  if (total === 0) {
    return <p className="text-muted-foreground text-xs">중복/환경 문제가 발견되지 않았습니다.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {duplicates.accounts.map((a) => (
        <WarnRow
          key={`acct-${a.service}-${a.identity}`}
          strong={a.crossKind}
          text={
            `같은 ${a.service === "github" ? "GitHub 계정" : "Notion bot"} '${a.identity}'이(가) ` +
            `${names(a.projects)}에 쓰입니다` +
            (a.crossKind ? " — 개인/업무 토큰 분리 권장 위반 가능" : "")
          }
        />
      ))}
      {duplicates.repos.map((g) => (
        <WarnRow
          key={`repo-${g.identity}`}
          text={`같은 레포 '${g.identity}'가 ${names(g.projects)}에 중복 등록됨`}
        />
      ))}
      {duplicates.notionDbs.map((g) => (
        <WarnRow
          key={`db-${g.identity}`}
          text={`같은 Notion DB '${g.identity}'가 ${names(g.projects)}에 중복 바인딩됨`}
        />
      ))}
      {environment.map((e) => (
        <WarnRow key={e.code} text={e.message} />
      ))}
    </div>
  );
}

const KIND_LABEL = { personal: "개인", work: "업무" } as const;

/** 설정 통합 상단의 "연결 점검" — 버튼 1개로 전 프로젝트 연결 검증 + 중복/분리 경고. */
export function ConnectionAuditPanel({ onToast }: { onToast: (msg: string) => void }) {
  const audit = useConnectionAudit();
  const data = audit.data;
  const groups = data ? groupByKind(data.projects) : null;
  const summary = data ? summarize(data) : null;

  return (
    <Card className="overflow-hidden rounded-2xl">
      <div className="border-border flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="text-muted-foreground size-4" />
          <SectionLabel>연결 점검</SectionLabel>
          {summary && (
            <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
              ✓ {summary.ok} · ✗ {summary.failed} ·
              <AlertTriangle aria-hidden className="size-3" />
              {summary.warnings}
            </span>
          )}
        </div>
        <Button
          size="sm"
          onClick={() => audit.mutate(undefined, { onError: () => onToast("연결 점검 실패") })}
          disabled={audit.isPending}
        >
          {audit.isPending ? "점검 중…" : "점검"}
        </Button>
      </div>

      {audit.isError && (
        <div className="px-4 py-3 text-xs text-[color:var(--destructive)]">
          {String(audit.error)}
        </div>
      )}

      {data && groups ? (
        <div className="flex flex-col gap-4 p-4">
          {(["personal", "work"] as const).map((kind) =>
            groups[kind].length > 0 ? (
              <div key={kind} className="flex flex-col gap-2">
                <SectionLabel>{KIND_LABEL[kind]}</SectionLabel>
                {groups[kind].map((p) => (
                  <ProjectRow key={p.projectId} p={p} />
                ))}
              </div>
            ) : null,
          )}
          <div className="flex flex-col gap-2">
            <SectionLabel>경고</SectionLabel>
            <Warnings audit={data} />
          </div>
        </div>
      ) : (
        !audit.isPending &&
        !audit.isError && (
          <p className="text-muted-foreground px-4 py-3 text-xs">
            모든 프로젝트의 토큰·Notion DB·Google·Gmail 연결을 한 번에 검증하고, 같은 레포/DB/계정
            중복과 개인·업무 분리 문제를 점검합니다.
          </p>
        )
      )}
    </Card>
  );
}
