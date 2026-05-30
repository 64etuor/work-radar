import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 외부 SKILL.md 읽기 전용 마크다운 렌더 (Phase 2 #7).
 *
 * Hermes 채팅 로그(HermesChatLog.tsx)와 동일한 렌더러 스택을 재사용한다:
 * `react-markdown` + `remark-gfm`. raw HTML은 실행하지 않는다(rehype-raw 미사용 —
 * 디스크에서 읽은 .md를 그대로 신뢰하지 않는 안전 기본값). 편집 affordance 없음 —
 * 순수 표시 전용. 시각 스타일은 `.skl-markdown`(SkillsView.css, --color-wr-* 토큰).
 */
export function SkillMarkdown({ body }: { body: string }) {
  return (
    <div className="skl-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
    </div>
  );
}
