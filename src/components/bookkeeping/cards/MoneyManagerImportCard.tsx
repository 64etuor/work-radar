import { FolderSearch, HardDriveDownload } from "lucide-react";

import type { BookkeepingMmbakOptions, BookkeepingSyncJob } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

import { Field } from "../../settings/SettingsKit";
import { FIELD_IDS } from "../bookkeepingConstants";
import { formatMmbakJobHint, MMBAK_WATCH_DIR_HINT } from "../mmbakImport";

/**
 * MoneyManager(.mmbak) 백업 임포트 카드 — 감시 폴더 설정 + 자동 가져오기 토글(24h 게이트,
 * 스케줄러 담당) + 즉시 가져오기. GmailSyncCard와 동일하게 상태는 BookkeepingView가 소유한다.
 */
export function MoneyManagerImportCard({
  options,
  draftWatchDir,
  savePending,
  importPending,
  lastJob,
  onDraftChange,
  onPickWatchDir,
  onSaveWatchDir,
  onToggleAutoImport,
  onImportNow,
}: {
  options: BookkeepingMmbakOptions | null;
  /** null = 아직 편집 안 함(서버 값 표시). */
  draftWatchDir: string | null;
  savePending: boolean;
  importPending: boolean;
  lastJob: BookkeepingSyncJob | null;
  onDraftChange: (value: string) => void;
  /** OS 디렉터리 다이얼로그로 폴더를 고르고 곧바로 저장한다. */
  onPickWatchDir: () => void;
  onSaveWatchDir: () => void;
  onToggleAutoImport: (enabled: boolean) => void;
  onImportNow: () => void;
}) {
  const watchDirValue = draftWatchDir ?? options?.watchDir ?? "";
  const configured = Boolean(options?.watchDir && options.watchDir.trim() !== "");

  return (
    <Card className="bk-card">
      <CardHeader className="bk-card-head">
        <CardTitle className="bk-card-title">
          <HardDriveDownload className="size-4" />
          머니매니저
        </CardTitle>
        <CardDescription className="bk-card-desc">
          백업 폴더의 최신 .mmbak을 읽어 거래를 가져옵니다. 원본 파일은 수정하지 않습니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="bk-card-body">
        <div className="bk-form">
          <Field label="백업 폴더" htmlFor={FIELD_IDS.mmbakWatchDir}>
            <div className="flex items-center gap-2">
              <Input
                id={FIELD_IDS.mmbakWatchDir}
                value={watchDirValue}
                onChange={(e) => onDraftChange(e.target.value)}
                placeholder="/…/내 드라이브/MoneyManager"
                title={watchDirValue || "선택된 폴더 없음"}
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={savePending}
                onClick={onPickWatchDir}
              >
                <FolderSearch className="size-3.5" />
                폴더 선택
              </Button>
            </div>
          </Field>
          {!configured && (
            <p className="text-muted-foreground typo-caption-sm">{MMBAK_WATCH_DIR_HINT}</p>
          )}
          <div className="flex items-center justify-between gap-2">
            <label
              className="text-muted-foreground typo-caption-sm"
              htmlFor={FIELD_IDS.mmbakAutoImport}
            >
              자동 가져오기 (24시간마다)
            </label>
            <Switch
              id={FIELD_IDS.mmbakAutoImport}
              checked={options?.autoImportEnabled ?? false}
              disabled={savePending || !configured}
              onCheckedChange={onToggleAutoImport}
            />
          </div>
          <div className="bk-gmail-actions">
            <Button type="button" disabled={savePending} onClick={onSaveWatchDir}>
              폴더 저장
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={importPending || !configured}
              onClick={onImportNow}
            >
              <HardDriveDownload className={importPending ? "size-4 animate-pulse" : "size-4"} />
              {importPending ? "가져오는 중…" : "지금 가져오기"}
            </Button>
          </div>
          {options?.lastAutoImportAt && (
            <p className="text-muted-foreground typo-caption-sm">
              마지막 자동 가져오기: {options.lastAutoImportAt}
            </p>
          )}
          {lastJob && (
            <p className="text-muted-foreground typo-caption-sm">{formatMmbakJobHint(lastJob)}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
