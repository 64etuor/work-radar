import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SkillMarkdown } from "@/components/SkillMarkdown";
import { HELP_MD } from "@/components/skillsHelpContent";

// vitest는 node 환경(jsdom/RTL 미도입 — vitest.config.ts)이라 radix Dialog의 portal은
// 정적 렌더되지 않는다. 대신 다이얼로그가 그대로 렌더하는 도움말 본문(HELP_MD)을 SkillMarkdown으로
// 정적 렌더해 핵심 섹션·문구가 실제 텍스트/엘리먼트로 나오는지 단언한다(SkillMarkdown.test.tsx 선례).
describe("SkillsHelpDialog 본문(HELP_MD)", () => {
  const html = renderToStaticMarkup(<SkillMarkdown body={HELP_MD} />);

  it("스킬 모델 섹션을 렌더한다", () => {
    expect(html).toContain("스킬 모델");
    expect(html).toContain("인앱 프롬프트");
    expect(html).toContain("외부 스킬");
  });

  it("외부 스킬이 읽기 전용·앱에서 실행 안 함임을 설명한다", () => {
    expect(html).toContain("읽기 전용");
    expect(html).toContain("앱에서 실행하지 않는다");
    expect(html).toContain("SSOT");
  });

  it("provider 배지·env 사이드바·사용자 설정 루트를 설명한다", () => {
    expect(html).toContain("provider");
    expect(html).toContain("claude");
    expect(html).toContain("codex");
    expect(html).toContain("openclaw");
    expect(html).toContain("hermes");
    expect(html).toContain("env 사이드바");
    expect(html).toContain("스킬 루트");
  });

  it("단축키 섹션을 렌더한다(⌘K 팔레트·그리드/리스트·Esc)", () => {
    expect(html).toContain("단축키");
    expect(html).toContain("⌘K");
    expect(html).toContain("커맨드 팔레트");
    expect(html).toContain("그리드");
    expect(html).toContain("리스트");
    expect(html).toContain("Esc");
  });

  it("마크다운으로 렌더한다(raw 텍스트 아님)", () => {
    expect(html).toContain("<h2>");
    expect(html).toContain("<li>");
    expect(html).not.toContain("## 스킬 모델");
  });
});
