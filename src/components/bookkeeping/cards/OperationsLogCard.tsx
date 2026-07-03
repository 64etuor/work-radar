import { ShieldAlert } from "lucide-react";

import type { BookkeepingAuditEntry, BookkeepingSyncJob } from "@/bindings";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { sourceLabel, syncStatusLabel } from "../bookkeepingLabels";
import { EmptyState } from "./_shared";

export function OperationsLogCard({
  syncJobs,
  audit,
}: {
  syncJobs: BookkeepingSyncJob[];
  audit: BookkeepingAuditEntry[];
}) {
  return (
    <Card className="bk-card">
      <CardHeader className="bk-card-head">
        <CardTitle className="bk-card-title">
          <ShieldAlert className="size-4" />
          운영 기록
        </CardTitle>
      </CardHeader>
      <CardContent className="bk-card-body">
        <div className="bk-side-list">
          {syncJobs.slice(0, 4).map((job) => (
            <div key={job.id} className="bk-log-row">
              <span className="typo-body-strong">
                {sourceLabel(job.source)} {syncStatusLabel(job.status)}
              </span>
              <span className="text-muted-foreground typo-caption-sm">
                {job.sanitizedErrorMessage ??
                  (job.status === "succeeded" ? "동기화 완료" : "동기화 실패")}
              </span>
            </div>
          ))}
          {audit.slice(0, 4).map((entry) => (
            <div key={entry.id} className="bk-log-row">
              <span className="typo-body-strong">{entry.action}</span>
              <span className="text-muted-foreground typo-caption-sm">{entry.summary}</span>
            </div>
          ))}
          {syncJobs.length === 0 && audit.length === 0 && <EmptyState>기록 없음</EmptyState>}
        </div>
      </CardContent>
    </Card>
  );
}
