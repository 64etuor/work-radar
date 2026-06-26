import { RefreshCw, Tags } from "lucide-react";
import { type Dispatch, type FormEvent, type SetStateAction } from "react";

import type { BookkeepingGmailLabel } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { Field } from "../../settings/SettingsKit";
import { FIELD_IDS } from "../bookkeepingConstants";
import { BOOKKEEPING_GMAIL_PERMISSION_COPY } from "../bookkeepingCopy";
import type { GmailSyncDraft } from "../bookkeepingDrafts";
import { appendCsvToken } from "../bookkeepingFieldUtils";
import { GMAIL_FULL_RESCAN_QUERY } from "../gmailSync";

export function GmailSyncCard({
  draft,
  labels,
  projectSelected,
  pending,
  lastSyncHint,
  onDraftChange,
  onSubmit,
}: {
  draft: GmailSyncDraft;
  labels: BookkeepingGmailLabel[];
  projectSelected: boolean;
  pending: boolean;
  lastSyncHint?: string | null;
  onDraftChange: Dispatch<SetStateAction<GmailSyncDraft>>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Card className="bk-card">
      <CardHeader>
        <CardTitle className="bk-card-title">
          <RefreshCw className="size-4" />
          Gmail
        </CardTitle>
        <CardDescription>{BOOKKEEPING_GMAIL_PERMISSION_COPY}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="bk-form" onSubmit={onSubmit}>
          <Field label="Gmail 라벨" htmlFor={FIELD_IDS.gmailLabels}>
            <Input
              id={FIELD_IDS.gmailLabels}
              value={draft.labels}
              onChange={(e) => onDraftChange((current) => ({ ...current, labels: e.target.value }))}
              placeholder="가계부, 영수증"
            />
          </Field>
          <Field label="검색어" htmlFor={FIELD_IDS.gmailQuery}>
            <Input
              id={FIELD_IDS.gmailQuery}
              value={draft.query}
              onChange={(e) => onDraftChange((current) => ({ ...current, query: e.target.value }))}
              placeholder="비우면 증분 동기화 · 예: newer_than:90d"
            />
          </Field>
          {labels.length > 0 && (
            <div className="bk-label-chips" aria-label="Gmail labels">
              {labels.slice(0, 8).map((label) => (
                <button
                  key={label.id}
                  type="button"
                  className="bk-label-chip typo-caption-sm"
                  onClick={() =>
                    onDraftChange((current) => ({
                      ...current,
                      labels: appendCsvToken(current.labels, label.name),
                    }))
                  }
                >
                  <Tags className="size-3" />
                  {label.name}
                </button>
              ))}
            </div>
          )}
          <div className="bk-gmail-actions">
            <Button type="submit" disabled={pending || !projectSelected}>
              <RefreshCw className="size-4" />
              Gmail 동기화
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() =>
                onDraftChange((current) => ({ ...current, query: GMAIL_FULL_RESCAN_QUERY }))
              }
            >
              전체 다시 스캔(90일)
            </Button>
          </div>
          {lastSyncHint && (
            <p className="text-muted-foreground typo-caption-sm">마지막 동기화: {lastSyncHint}</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
