import { RefreshCw } from "lucide-react";
import { useState } from "react";

import type { SkillProvider } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  useApplySkillUpdate,
  useCheckSkillUpdates,
  useSetSkillAutoUpdate,
  useSetSkillUpdateOnLaunch,
  useSkillUpdateOnLaunch,
  useSkillUpdateStatus,
} from "@/lib/query";

/**
 * 업데이트 패널(G1.5-PR3). 추적 스킬의 업스트림을 확인(fetch-only·bounded·staging만)하고, 새 버전을
 * 적용(사전 전체 백업 후 교체 — 가역)하며, per-skill auto-update와 on-launch opt-in을 토글한다. 적용
 * confirm은 **인라인 2단계**(중첩 Dialog 회피 → Sheet Esc 계약 무영향). 자동 실행/적용 없음(#1/#2).
 */
export function UpdatePanel({ onDone }: { onDone: () => void }) {
  const status = useSkillUpdateStatus();
  const check = useCheckSkillUpdates();
  const setAuto = useSetSkillAutoUpdate();
  const apply = useApplySkillUpdate();
  const onLaunch = useSkillUpdateOnLaunch();
  const setOnLaunch = useSetSkillUpdateOnLaunch();
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const doCheck = () => {
    if (check.isPending) return;
    setNote(null);
    check.mutate(undefined, {
      onSuccess: (rows) => {
        const n = rows.filter((r) => r.updateAvailable).length;
        setNote(n > 0 ? `${n}개 업데이트 가능` : "모두 최신입니다");
      },
      onError: (e) => setNote(`확인 실패: ${(e as Error).message}`),
    });
  };

  const doApply = (provider: SkillProvider, name: string) => {
    if (apply.isPending) return;
    setNote(null);
    apply.mutate(
      { provider, name },
      {
        onSuccess: () => setConfirmKey(null),
        onError: (e) => setNote(`적용 실패: ${(e as Error).message}`),
      },
    );
  };

  const rows = status.data ?? [];
  return (
    <div className="skl-edit">
      <p className="skl-desc">
        설치한 스킬의 업스트림을 확인합니다. 네트워크는 Rust에서 bounded로 처리되고, 새 버전은
        staging에만 받아둡니다 — 적용은 아래에서 직접 누를 때만 일어나며 자동 실행은 없습니다.
      </p>
      <div className="skl-actions">
        <Button className="gap-1.5 rounded-full" onClick={doCheck} disabled={check.isPending}>
          <RefreshCw className="size-4" />
          {check.isPending ? "확인 중…" : "지금 확인"}
        </Button>
        <Button variant="outline" className="rounded-full" onClick={onDone}>
          닫기
        </Button>
      </div>
      <div className="skl-update-launch">
        <Switch
          checked={!!onLaunch.data}
          onCheckedChange={(v) => setOnLaunch.mutate(v)}
          aria-label="앱 시작 시 스킬 업데이트 자동 확인"
        />
        <span className="skl-desc">앱 시작 시 자동 확인(opt-in · 한 번만 · 자동 적용 안 함)</span>
      </div>
      {note && <span className="skl-note">{note}</span>}

      <ul className="skl-backup-list">
        {rows.map((r) => {
          const key = `${r.provider}:${r.name}`;
          return (
            <li key={key} className="skl-backup-row">
              <span className="font-mono">{r.name}</span>
              <div className="skl-update-ctl">
                {r.updateAvailable && <Badge variant="default">업데이트 가능</Badge>}
                <div className="skl-update-toggle">
                  <Switch
                    checked={r.autoUpdate}
                    onCheckedChange={(v) =>
                      setAuto.mutate({
                        provider: r.provider as SkillProvider,
                        name: r.name,
                        enabled: v,
                      })
                    }
                    aria-label={`${r.name} 자동 업데이트`}
                  />
                  <span className="skl-desc">자동</span>
                </div>
                {r.updateAvailable &&
                  (confirmKey === key ? (
                    <>
                      <Button
                        size="pill-sm"
                        disabled={apply.isPending}
                        onClick={() => doApply(r.provider as SkillProvider, r.name)}
                      >
                        {apply.isPending ? "적용 중…" : "정말 적용"}
                      </Button>
                      <Button size="pill-sm" variant="outline" onClick={() => setConfirmKey(null)}>
                        취소
                      </Button>
                    </>
                  ) : (
                    <Button size="pill-sm" variant="outline" onClick={() => setConfirmKey(key)}>
                      적용…
                    </Button>
                  ))}
              </div>
            </li>
          );
        })}
        {rows.length === 0 && <li className="skl-desc">설치된(추적 중인) 스킬이 없습니다.</li>}
      </ul>
    </div>
  );
}
