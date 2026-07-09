import { Button } from "@/components/ui/button";
import { useSkillAudit } from "@/lib/query";

/**
 * 감사 로그 뷰어(G1, ADR-0006 레일 ①). append-only `skill_audit_log`를 최근 먼저 표시한다. 읽기 전용 —
 * 중앙 라이브러리에 대한 모든 쓰기(설치·제거·복사·동기화·업데이트) 이력. 자동 실행/적용 없음(#1/#2).
 */
export function AuditPanel({ onDone }: { onDone: () => void }) {
  const audit = useSkillAudit();
  const rows = audit.data ?? [];
  return (
    <div className="skl-edit">
      <p className="skl-desc">
        중앙 라이브러리에 대한 모든 쓰기(설치·제거·복사·동기화·업데이트)를 최근 순으로 기록한
        append-only 감사 로그입니다. 읽기 전용입니다.
      </p>
      <div className="skl-actions">
        <Button variant="outline" size="pill" className="px-4" onClick={onDone}>
          닫기
        </Button>
      </div>
      {audit.isError && (
        <span className="skl-note err">
          감사 로그를 불러오지 못했습니다: {(audit.error as Error).message}
        </span>
      )}
      <ul className="skl-audit-list">
        {rows.map((e) => (
          <li key={e.id} className="skl-audit-row">
            <div className="skl-audit-head">
              <span className="skl-audit-action">{e.action}</span>
              <span className="skl-audit-kind">{e.targetKind}</span>
              <span className="skl-audit-time font-mono">{e.createdAt}</span>
            </div>
            <span className="skl-audit-target font-mono" title={e.targetRef}>
              {e.targetRef}
            </span>
            {e.detail && (
              <span className="skl-audit-detail" title={e.detail}>
                {e.detail}
              </span>
            )}
          </li>
        ))}
        {rows.length === 0 && !audit.isError && <li className="skl-desc">아직 기록이 없습니다.</li>}
      </ul>
    </div>
  );
}
