import { useState } from "react";

import { useCodexStatus } from "@/lib/query/agents";
import { useCodexModel, useSetCodexModel } from "@/lib/query/agentsConfig";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/components/ui/cn";
import { SectionLabel, StatusDot } from "./kit";

/**
 * 에이전트 설정 패널 (B2 Part B).
 * - Codex 설치/인증 상태 표시.
 * - Codex 모델 설정: 자유 입력 + 공통 프리셋. app_config(SQLite) 영속, 비밀 아님.
 * - 미설정이면 codex 기본 동작(모델 플래그 없음).
 */
export function AgentsPane({ onToast }: { onToast: (msg: string) => void }) {
  const status = useCodexStatus();
  const model = useCodexModel();
  const setModel = useSetCodexModel();

  const [draft, setDraft] = useState<string | null>(null);
  // draft가 null이면 서버 값을 표시, 편집 중이면 draft 값.
  const displayValue = draft !== null ? draft : (model.data ?? "");

  const avail = status.data;

  const save = () => {
    const val = (draft ?? "").trim();
    setModel.mutate(val || null, {
      onSuccess: () => {
        setDraft(null);
        onToast(val ? `Codex 모델 설정됨: ${val}` : "Codex 모델 기본값으로 초기화됨");
      },
      onError: (e) => onToast(String(e)),
    });
  };

  const reset = () => {
    setModel.mutate(null, {
      onSuccess: () => {
        setDraft(null);
        onToast("Codex 모델 기본값으로 초기화됨");
      },
      onError: (e) => onToast(String(e)),
    });
  };

  const PRESETS = [
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "o4-mini",
    "o3",
  ];

  const statusText =
    avail === undefined
      ? "확인 중…"
      : avail.installed
        ? avail.authed
          ? `설치·로그인됨 (${avail.version ?? ""})`
          : "설치됨 / 미로그인"
        : "미설치";

  return (
    <div className="flex flex-col gap-4">
      {/* Codex 상태 */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">Codex CLI</span>
        <StatusDot on={avail?.installed ?? false}>{statusText}</StatusDot>
      </div>

      {avail && !avail.installed && (
        <p className="text-xs text-muted-foreground">
          codex CLI를 설치하세요: <code>npm install -g @openai/codex</code> 후 재시작.
        </p>
      )}
      {avail && avail.installed && !avail.authed && (
        <p className="text-xs text-muted-foreground">
          <code>codex login</code>을 실행해 인증하세요.
        </p>
      )}
      {avail?.detail && avail.installed && (
        <p className="text-xs text-muted-foreground">{avail.detail}</p>
      )}

      {/* Codex 모델 설정 */}
      <div className="flex flex-col gap-2">
        <SectionLabel>Codex 모델</SectionLabel>
        <div className="flex items-center gap-2">
          <Input
            value={displayValue}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="기본값 (미설정 시 codex 내장 모델)"
            aria-label="Codex 모델"
            className="font-mono"
          />
          <Button
            size="sm"
            className="shrink-0"
            onClick={save}
            disabled={
              setModel.isPending ||
              (draft === null || draft.trim() === (model.data ?? ""))
            }
          >
            {setModel.isPending ? "저장 중…" : "저장"}
          </Button>
          {(model.data || draft) && (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={reset}
              disabled={setModel.isPending}
            >
              초기화
            </Button>
          )}
        </div>
      </div>

      {/* 공통 프리셋 */}
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <Button
            key={p}
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "font-mono text-[11px]",
              displayValue === p && "bg-muted",
            )}
            onClick={() => setDraft(p)}
          >
            {p}
          </Button>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        미설정 시 codex CLI 기본 모델을 사용합니다. 설정하면 모든 에이전트 잡에{" "}
        <code>--model</code> 플래그로 전달됩니다. 재시작 없이 다음 잡부터 적용됩니다.
      </p>

      {model.isError && (
        <p className="text-xs text-[color:var(--destructive)]">{String(model.error)}</p>
      )}
      {setModel.isError && (
        <p className="text-xs text-[color:var(--destructive)]">{String(setModel.error)}</p>
      )}
    </div>
  );
}
