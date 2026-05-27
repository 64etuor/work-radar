import type { UseMutationResult } from "@tanstack/react-query";
import type { TriggerCodexInput, TriggerEchoInput } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function JobControls({
  codexReady,
  prompt,
  echoJob,
  codexJob,
  onPromptChange,
  onCodexSuccess,
}: {
  codexReady: boolean;
  prompt: string;
  echoJob: UseMutationResult<string, Error, TriggerEchoInput, unknown>;
  codexJob: UseMutationResult<string, Error, TriggerCodexInput, unknown>;
  onPromptChange: (prompt: string) => void;
  onCodexSuccess: () => void;
}) {
  return (
    <section className="jobs-controls">
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
      {(echoJob.error || codexJob.error) && (
        <div className="jobs-err">
          {echoJob.error?.message ?? codexJob.error?.message}
        </div>
      )}
    </section>
  );
}
