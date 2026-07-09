import { Archive } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useBackupSkillLibrary, useRestoreSkillLibrary, useSkillBackups } from "@/lib/query";

/**
 * 백업/복원 패널(G1.5-PR2). 중앙 라이브러리 전체를 타임스탬프 스냅샷으로 백업하고, 스냅샷으로 복원한다.
 * 복원 confirm은 **인라인 2단계**(중첩 Dialog 회피 → Sheet overlay-stack / Esc 계약 무영향). 모든 작업은
 * 로컬 파일 복사 + 감사(잡 비취급 — #1/#2). 복원은 직전 상태를 사전 안전 스냅샷으로 보존하므로 가역.
 */
export function BackupPanel({ onDone }: { onDone: () => void }) {
  const backups = useSkillBackups();
  const backup = useBackupSkillLibrary();
  const restore = useRestoreSkillLibrary();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const doBackup = () => {
    if (backup.isPending) return;
    setNote(null);
    backup.mutate(undefined, {
      onSuccess: (m) => setNote(`백업 완료: ${m.skillCount}개 스킬 (${m.id})`),
      onError: (e) => setNote(`백업 실패: ${(e as Error).message}`),
    });
  };

  const doRestore = (id: string) => {
    if (restore.isPending) return;
    setNote(null);
    restore.mutate(id, {
      onSuccess: () => {
        setConfirmId(null);
        onDone();
      },
      onError: (e) => setNote(`복원 실패: ${(e as Error).message}`),
    });
  };

  return (
    <div className="skl-edit">
      <p className="skl-desc">
        중앙 라이브러리 전체를 타임스탬프 스냅샷으로 백업합니다. 복원은 직전 상태를 안전 스냅샷으로
        보존한 뒤 교체하므로 되돌릴 수 있습니다. 모든 작업은 로컬 파일 복사이며 감사됩니다.
      </p>
      <div className="skl-actions">
        <Button className="gap-1.5 rounded-full" onClick={doBackup} disabled={backup.isPending}>
          <Archive className="size-4" />
          {backup.isPending ? "백업 중…" : "지금 백업"}
        </Button>
        <Button variant="outline" className="rounded-full" onClick={onDone}>
          닫기
        </Button>
      </div>
      {note && <span className="skl-note">{note}</span>}

      <ul className="skl-backup-list">
        {(backups.data ?? []).map((b) => (
          <li key={b.id} className="skl-backup-row">
            <span className="font-mono">{b.createdAt}</span>
            <span className="skl-desc">{b.skillCount}개 스킬</span>
            {confirmId === b.id ? (
              <span className="skl-actions">
                <Button size="pill-sm" onClick={() => doRestore(b.id)} disabled={restore.isPending}>
                  {restore.isPending ? "복원 중…" : "정말 복원"}
                </Button>
                <Button size="pill-sm" variant="outline" onClick={() => setConfirmId(null)}>
                  취소
                </Button>
              </span>
            ) : (
              <Button size="pill-sm" variant="outline" onClick={() => setConfirmId(b.id)}>
                복원…
              </Button>
            )}
          </li>
        ))}
        {backups.data?.length === 0 && <li className="skl-desc">아직 백업이 없습니다.</li>}
      </ul>
    </div>
  );
}
