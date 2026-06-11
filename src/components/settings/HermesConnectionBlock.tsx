import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, RefreshCw, XCircle } from "lucide-react";

import { commands } from "@/bindings";
import { Button } from "@/components/ui/button";
import { unwrap } from "@/lib/query/client";

/**
 * Hermes 로컬 설치 감지 + ACP 준비 상태 표시 (Phase B2).
 * hermesDetect IPC를 폴링해 installed / acp_ready / version / path / error 를 보여준다.
 */
export function HermesConnectionBlock() {
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["hermes-detect"],
    queryFn: () => unwrap(commands.hermesDetect()),
    staleTime: 60_000,
  });

  return (
    <section className="border-border space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Hermes 연결</h3>
        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={isFetching ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          <span className="ml-1">재감지</span>
        </Button>
      </div>

      {isLoading && <p className="text-muted-foreground text-xs">감지 중…</p>}

      {data && !data.installed && (
        <div className="flex items-start gap-2 text-sm text-[color:var(--destructive)]">
          <XCircle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p>Hermes를 찾을 수 없습니다.</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              설치 후 재감지하세요 (예: <code>pip install hermes-agent</code>).
            </p>
            {data.error && <p className="text-muted-foreground mt-1 text-xs">{data.error}</p>}
          </div>
        </div>
      )}

      {data && data.installed && data.acp_ready && (
        <div className="flex items-start gap-2 text-sm">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[color:var(--success)]" />
          <div>
            <p>Hermes {data.version ?? ""} 감지됨 · ACP 준비 완료</p>
            {data.path && (
              <p className="text-muted-foreground text-xs">
                <code>{data.path}</code>
              </p>
            )}
          </div>
        </div>
      )}

      {data && data.installed && !data.acp_ready && (
        <div className="text-accent flex items-start gap-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p>Hermes {data.version ?? ""} 감지됨이나 ACP 준비 미완.</p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              터미널에서 <code>hermes acp --setup</code> 실행 후 재감지하세요.
            </p>
            {data.error && <p className="text-muted-foreground mt-1 text-xs">{data.error}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
