import { SkillMarkdown } from "@/components/SkillMarkdown";
import { HELP_MD } from "@/components/skillsHelpContent";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

/**
 * 스킬 레지스트리 도움말 다이얼로그 (Phase 2 #11). 스킬 모델(인앱 vs 외부)·provider
 * 배지·env 사이드바·관련 단축키를 설명한다. 표시 전용 — 어떤 잡/스킬도 실행하지 않는다.
 *
 * overlay-stack 계약: `@/components/ui/dialog`의 `DialogContent`가 정적 `data-wr-overlay-open`
 * 마커를 달고 radix가 Esc 닫기·포커스 복원·레이어 스택을 전담한다(별도 카운터/`onEscapeKeyDown`
 * 불필요 — shadcn-migration.md §"radix Dialog Esc 계약"의 프로그램적 모달 경로). 컨테이너 SkillsView가
 * controlled `open`을 소유한다(로컬 useState — 전역 store 상태 아님).
 *
 * 본문은 하드코딩 마크다운 상수(HELP_MD)를 SkillMarkdown(react-markdown, raw HTML 미실행)로 렌더한다.
 */
export function SkillsHelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="skl-help" aria-describedby={undefined}>
        <DialogTitle>스킬 레지스트리 도움말</DialogTitle>
        <SkillMarkdown body={HELP_MD} />
      </DialogContent>
    </Dialog>
  );
}
