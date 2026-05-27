import { Moon, Sun } from "lucide-react";

import { useUIStore } from "@/store";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FONT_PRESETS, fontFamilyFor } from "@/lib/fontPresets";

/**
 * 외관 (Appearance) 설정 — 단일 전역. 테마(light/dark)와 본문 폰트 프리셋만 다룬다.
 * 타이틀(`--font-display`)·모노(`--font-mono`)는 DESIGN.md 정본을 유지(변경 대상 아님).
 * 모든 상태는 zustand + localStorage에 있고 App.tsx 부팅 effect가 `--font-sans`를 적용한다.
 */
export function AppearanceSettings() {
  const { theme, setTheme, font, setFont } = useUIStore();

  const current = FONT_PRESETS.find((p) => p.id === font) ?? FONT_PRESETS[1];

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <header>
          <h3 className="text-sm font-medium">테마</h3>
          <p className="text-muted-foreground mt-1 text-xs">앱 전체에 적용되는 라이트/다크 모드.</p>
        </header>
        <ToggleGroup
          type="single"
          value={theme}
          onValueChange={(v) => {
            if (v === "light" || v === "dark") setTheme(v);
          }}
          className="w-fit"
        >
          <ToggleGroupItem value="light" aria-label="라이트 모드" className="gap-1.5">
            <Sun className="size-4" />
            라이트
          </ToggleGroupItem>
          <ToggleGroupItem value="dark" aria-label="다크 모드" className="gap-1.5">
            <Moon className="size-4" />
            다크
          </ToggleGroupItem>
        </ToggleGroup>
      </section>

      <section className="flex flex-col gap-3">
        <header>
          <h3 className="text-sm font-medium">본문 폰트</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            `--font-sans` 토큰을 덮어쓴다. 타이틀·코드 블록은 변경되지 않는다.
          </p>
        </header>
        <Select value={font} onValueChange={(v) => setFont(v as typeof font)}>
          <SelectTrigger className="w-72">
            <SelectValue placeholder="폰트 선택" />
          </SelectTrigger>
          <SelectContent>
            {FONT_PRESETS.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                <span style={{ fontFamily: p.family }}>{p.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">{current.hint}</p>

        <div
          className="border-border bg-muted/30 mt-2 rounded-md border p-4"
          style={{ fontFamily: fontFamilyFor(font) }}
        >
          <p className="text-base leading-relaxed">
            오늘은 데일리 리뷰를 빠르게 끝내고, Work Radar에 새 신호를 모아둡니다.
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            The quick brown fox jumps over the lazy dog. 0123456789
          </p>
        </div>
      </section>
    </div>
  );
}
