import { cn } from "@/components/ui/cn";
import type { SkillEnvNavItem } from "@/lib/skillEnvNav";

/** 좌측 환경 사이드바 한 항목(필터 버튼 + enabled/total 배지). "전체"를 제외하면 드래그로 재정렬 가능
 * (로컬 표시 순서 — 외부 상태 불변, #14). */
export function EnvNavButton({
  item,
  count,
  active,
  onSelect,
  onDragStart,
  onDropItem,
  diverged,
}: {
  item: SkillEnvNavItem;
  count: { enabled: number; total: number };
  active: boolean;
  onSelect: () => void;
  onDragStart: () => void;
  onDropItem: () => void;
  /** 이 워크스페이스의 diverged 멤버 수(#17 헬스 배지). >0일 때만 배지 렌더. env 항목은 미전달. */
  diverged?: number;
}) {
  const draggable = !item.pinned;
  return (
    <button
      type="button"
      className={cn("skl-env", active && "active")}
      aria-pressed={active}
      onClick={onSelect}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragOver={draggable ? (e) => e.preventDefault() : undefined}
      onDrop={
        draggable
          ? (e) => {
              e.preventDefault();
              onDropItem();
            }
          : undefined
      }
    >
      <span className="skl-env-label">{item.label}</span>
      {diverged != null && diverged > 0 && (
        <span className="skl-env-diverged" title={`중앙과 다른 카피 ${diverged}개`}>
          {diverged} 다름
        </span>
      )}
      <span className="skl-env-count">
        {count.enabled}/{count.total}
      </span>
    </button>
  );
}
