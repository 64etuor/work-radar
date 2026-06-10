import { Blocks, FileText } from "lucide-react";

import type { Skill } from "@/bindings";
import { cn } from "@/components/ui/cn";
import { providerLabel, skillCardBadges } from "@/lib/skillBadges";
import { groupProviders, type SkillLocation } from "@/lib/skillDedup";

/** /Users/<me> 접두를 ~로 축약(외부 스킬 경로 표시용). */
function compactPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

/** 레지스트리 카드(인앱/외부 공통). 클릭하면 Sheet로 보기/편집. grid/list 두 변형. 도구 간 그룹
 * 카드(`locations.length > 1`)는 단일 provider 배지 대신 "N곳" + 출처 칩(중복 제거)을 보여준다(#4). */
export function SkillCard({
  skill,
  locations,
  listView,
  active,
  onSelect,
}: {
  skill: Skill;
  locations: SkillLocation[];
  listView: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  const isInApp = skill.kind === "in_app_prompt";
  const Icon = isInApp ? Blocks : FileText;
  const desc = (skill.prompt ?? "").trim();
  const sub = isInApp ? skill.binding : skill.sourcePath ? compactPath(skill.sourcePath) : null;
  const grouped = locations.length > 1;
  // 그룹 카드는 대표의 단일 provider 배지를 빼고(아래에서 출처 칩으로 대체) kind/off만 남긴다.
  const badges = grouped
    ? skillCardBadges(skill).filter((b) => b.tone !== "provider")
    : skillCardBadges(skill);
  const providers = grouped ? groupProviders(locations) : [];

  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn("skl-card", listView ? "list" : "grid", active && "active")}
      onClick={onSelect}
    >
      <span className="skl-card-top">
        <Icon className="skl-card-ico size-4" />
        <span className="skl-card-name">{skill.name}</span>
        <span className="skl-card-badges">
          {badges.map((b) => (
            <span key={b.key} className={cn("skl-badge", `skl-badge-${b.tone}`)}>
              {b.label}
            </span>
          ))}
          {grouped && (
            <>
              <span className="skl-badge skl-badge-locs">{locations.length}곳</span>
              {providers.map((p) => (
                <span key={p} className="skl-badge skl-badge-provider">
                  {providerLabel(p)}
                </span>
              ))}
            </>
          )}
        </span>
      </span>
      {sub && <span className="skl-card-sub">{sub}</span>}
      {desc && <span className="skl-card-desc">{desc}</span>}
      {skill.tags.length > 0 && (
        <span className="skl-card-tags">
          {skill.tags.map((t) => (
            <span key={t} className="skl-card-tag">
              {t}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}
