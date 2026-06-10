import { FolderGit2, Github, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDeleteRepo } from "@/lib/query";

export function RepoRow({
  repoId,
  projectId,
  provider,
  loc,
  branch,
  onToast,
}: {
  repoId: string;
  projectId: string;
  provider: string;
  loc: string;
  branch: string;
  onToast: (msg: string) => void;
}) {
  const del = useDeleteRepo();
  return (
    <div className="border-border flex items-center gap-3 rounded-lg border px-3.5 py-2.5">
      {provider === "github" ? (
        <Github className="text-muted-foreground size-4 shrink-0" />
      ) : (
        <FolderGit2 className="text-muted-foreground size-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{loc}</span>
      <Badge variant="outline">{branch}</Badge>
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-destructive size-7 shrink-0 p-0"
        aria-label="레포 연결 해제"
        title="레포 연결 해제"
        disabled={del.isPending}
        onClick={() =>
          del.mutate(
            { repoId, projectId },
            {
              onSuccess: () => onToast("레포 연결 해제됨"),
              onError: () => onToast("레포 제거 실패"),
            },
          )
        }
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}
