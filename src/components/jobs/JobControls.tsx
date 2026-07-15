import type { UseMutationResult } from "@tanstack/react-query";

import type { TriggerCodexInput, TriggerEchoInput } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import { CodexStatusBanner } from "./CodexStatusBanner";

export function JobControls({
  codexReady,
  codexDetail,
  codexVersion,
  prompt,
  echoJob,
  codexJob,
  onPromptChange,
  onCodexSuccess,
}: {
  codexReady: boolean;
  codexDetail: string | null | undefined;
  codexVersion: string | null | undefined;
  prompt: string;
  echoJob: UseMutationResult<string, Error, TriggerEchoInput, unknown>;
  codexJob: UseMutationResult<string, Error, TriggerCodexInput, unknown>;
  onPromptChange: (prompt: string) => void;
  onCodexSuccess: () => void;
}) {
  return (
    <section className="jobs-controls" aria-labelledby="jobs-launcher-title">
      <div className="jobs-controls-head">
        <div>
          <span className="jobs-section-kicker">NEW RUN</span>
          <h2 id="jobs-launcher-title">새 작업 실행</h2>
          <p>read-only 샌드박스에서 최대 8턴·60초·$1 한도로 실행합니다.</p>
        </div>
        <CodexStatusBanner ready={codexReady} detail={codexDetail} version={codexVersion} />
      </div>

      <div className="jobs-codex-form">
        <Textarea
          className="min-h-0 resize-y"
          placeholder={
            codexReady
              ? "codex 잡 프롬프트 (read-only 샌드박스)…"
              : "codex 미가용 — 설치·로그인 후 사용"
          }
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          disabled={!codexReady}
          rows={2}
        />
        <Button
          size="sm"
          className="self-start rounded-full text-[12px]"
          disabled={!codexReady || codexJob.isPending || !prompt.trim()}
          onClick={() =>
            codexJob.mutate(
              {
                projectId: null,
                repoId: null,
                agentPromptBinding: null,
                prompt,
                timeoutSec: 60,
                maxTurns: 8,
                costCapUsd: 1.0,
              },
              { onSuccess: onCodexSuccess },
            )
          }
        >
          codex 잡 실행
        </Button>
      </div>

      <div className="jobs-diagnostics">
        <div className="jobs-diagnostics-copy">
          <span className="jobs-section-kicker">DIAGNOSTICS</span>
          <strong>실행 환경 진단</strong>
          <small>bounded 실행과 timeout kill 경로를 확인합니다.</small>
        </div>
        <div className="jobs-controls-row">
          <Button
            variant="outline"
            size="sm"
            className="rounded-full text-[12px]"
            disabled={echoJob.isPending}
            onClick={() =>
              echoJob.mutate({
                seconds: 0,
                timeoutSec: 20,
                message: "echo 테스트 — bound 내 실행",
              })
            }
          >
            Echo 잡 (즉시 완료)
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="rounded-full text-[12px]"
            disabled={echoJob.isPending}
            onClick={() =>
              echoJob.mutate({
                seconds: 30,
                timeoutSec: 3,
                message: "timeout 테스트 — 3s 후 kill",
              })
            }
          >
            Timeout 잡 (3s→kill)
          </Button>
        </div>
      </div>
      {(echoJob.error || codexJob.error) && (
        <div className="jobs-err" role="status">
          {echoJob.error?.message ?? codexJob.error?.message}
        </div>
      )}
    </section>
  );
}
