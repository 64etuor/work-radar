import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SkillMarkdown } from "@/components/SkillMarkdown";

// vitest는 node 환경(jsdom/RTL 미도입 — vitest.config.ts 참고)이라
// react-dom/server의 정적 렌더로 마크다운→HTML 변환만 검증한다(추가 의존성 0).
const MD = [
  "# 제목",
  "",
  "- 첫 항목",
  "- 둘째 항목",
  "",
  "```sh",
  "skills.sh install foo",
  "```",
  "",
  "[링크](https://example.com)",
].join("\n");

describe("SkillMarkdown", () => {
  const html = renderToStaticMarkup(<SkillMarkdown body={MD} />);

  it("외부 SKILL.md를 raw 텍스트가 아니라 마크다운으로 렌더한다", () => {
    expect(html).not.toContain("# 제목");
    expect(html).not.toContain("```");
  });

  it("헤딩을 <h1>으로 렌더한다", () => {
    expect(html).toContain("<h1>제목</h1>");
  });

  it("코드블록을 <pre>/<code>로 렌더한다", () => {
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    expect(html).toContain("skills.sh install foo");
  });

  it("불릿 리스트를 <li>로 렌더한다", () => {
    expect(html).toContain("<li>첫 항목</li>");
    expect(html).toContain("<li>둘째 항목</li>");
  });

  it("링크를 <a href>로 렌더한다", () => {
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain(">링크</a>");
  });

  it("raw HTML을 실행하지 않는다(rehype-raw 미사용 — 디스크 .md 안전 기본값)", () => {
    const danger = renderToStaticMarkup(<SkillMarkdown body={"<script>alert(1)</script>"} />);
    expect(danger).not.toContain("<script>");
  });
});
