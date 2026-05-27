import { Bot } from "lucide-react";

export function CodexStatusBanner({
  ready,
  detail,
  version,
}: {
  ready: boolean;
  detail: string | null | undefined;
  version: string | null | undefined;
}) {
  return (
    <div className={`jobs-codex ${ready ? "jobs-codex-ok" : "jobs-codex-off"}`}>
      <Bot className="size-4" />
      <span>{detail ?? "codex 상태 확인 중…"}</span>
      {version && <span className="jobs-codex-ver">{version}</span>}
    </div>
  );
}
