import { useEffect, useState } from "react";

import {
  useGlobalHotkey,
  useNavKeymap,
  useResetGlobalHotkey,
  useResetNavKeymap,
  useSetGlobalHotkey,
  useSetNavKeymap,
} from "@/lib/query";
import { NAV_ITEMS } from "@/lib/nav";

/**
 * 네비게이션 설정 (Phase 18 #7). 글로벌 창 핫키 편집/리셋 + per-view 단축키 keymap 편집/리셋.
 * - 글로벌 핫키: 변경 시 Rust가 런타임 재등록(충돌/무효 시 옛 핫키 유지 + 에러 노출).
 * - keymap: view→shortcut. 단일 키("1") 또는 chord("g b"). 빈 값 = 그 뷰 단축키 비활성.
 *   저장 시 app_config(JSON)로 영속, 입력 비포커스 시 전역 적용(App.tsx).
 */
export function NavigationSettings({
  onToast,
}: {
  onToast: (msg: string) => void;
}) {
  const hotkey = useGlobalHotkey();
  const setHotkey = useSetGlobalHotkey();
  const resetHotkey = useResetGlobalHotkey();

  const keymap = useNavKeymap();
  const setKeymap = useSetNavKeymap();
  const resetKeymap = useResetNavKeymap();

  // 핫키 입력 드래프트 (저장 전 편집 버퍼).
  const [hkDraft, setHkDraft] = useState("");
  useEffect(() => {
    if (hotkey.data) setHkDraft(hotkey.data);
  }, [hotkey.data]);

  // keymap 드래프트 (view → shortcut).
  const [kmDraft, setKmDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (keymap.data) setKmDraft(keymap.data);
  }, [keymap.data]);

  const saveHotkey = () => {
    const spec = hkDraft.trim();
    if (!spec || setHotkey.isPending) return;
    setHotkey.mutate(spec, {
      onSuccess: () => onToast(`글로벌 핫키 변경됨: ${spec}`),
      onError: (e) => onToast(String(e)),
    });
  };

  const resetHk = () => {
    if (resetHotkey.isPending) return;
    resetHotkey.mutate(undefined, {
      onSuccess: (def) => onToast(`글로벌 핫키 기본값으로: ${def}`),
      onError: (e) => onToast(String(e)),
    });
  };

  const saveKeymap = () => {
    if (setKeymap.isPending) return;
    // 빈 문자열은 trim해서 그대로(= 비활성) 저장.
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(kmDraft)) cleaned[k] = v.trim();
    setKeymap.mutate(cleaned, {
      onSuccess: () => onToast("메뉴 단축키 저장됨"),
      onError: (e) => onToast(String(e)),
    });
  };

  const resetKm = () => {
    if (resetKeymap.isPending) return;
    resetKeymap.mutate(undefined, {
      onSuccess: () => onToast("메뉴 단축키 기본값으로 리셋됨"),
      onError: (e) => onToast(String(e)),
    });
  };

  return (
    <div className="st-token">
      <div className="st-token-head">
        <span className="st-token-lbl">네비게이션 / 단축키</span>
      </div>

      {/* 글로벌 창 핫키 */}
      <div className="st-token-row">
        <span className="st-status" style={{ minWidth: 96 }}>
          글로벌 창 핫키
        </span>
        <input
          className="st-input"
          value={hkDraft}
          onChange={(e) => setHkDraft(e.target.value)}
          placeholder="Ctrl+Space"
          aria-label="글로벌 창 토글 핫키"
          style={{ width: 180, fontFamily: "var(--font-mono)" }}
        />
        <button
          type="button"
          className="st-btn sm"
          onClick={saveHotkey}
          disabled={setHotkey.isPending || hkDraft.trim() === hotkey.data}
          title="창 토글 핫키를 변경하고 즉시 재등록"
        >
          {setHotkey.isPending ? "등록 중…" : "변경"}
        </button>
        <button
          type="button"
          className="st-btn-ghost sm"
          onClick={resetHk}
          disabled={resetHotkey.isPending}
          title="기본값 Ctrl+Space로 리셋"
        >
          기본값
        </button>
      </div>
      <div className="st-hint">
        모디파이어 + 키 형식 (예: <code>Ctrl+Space</code>, <code>Cmd+Shift+K</code>). 변경 시
        즉시 재등록되며, 다른 앱과 충돌하거나 형식이 잘못되면 이전 핫키를 유지하고 오류를
        표시합니다.
      </div>

      {/* per-view keymap */}
      <div className="st-section-lbl" style={{ marginTop: 12 }}>
        메뉴별 단축키 (입력 중이 아닐 때 적용)
      </div>
      <div className="nav-keymap-grid">
        {NAV_ITEMS.map((item) => (
          <div key={item.view} className="nav-keymap-row">
            <span className="nav-keymap-label">{item.label}</span>
            <input
              className="st-input"
              value={kmDraft[item.view] ?? ""}
              onChange={(e) =>
                setKmDraft((prev) => ({ ...prev, [item.view]: e.target.value }))
              }
              placeholder="단축키 없음"
              aria-label={`${item.label} 단축키`}
              style={{ width: 110, fontFamily: "var(--font-mono)" }}
            />
          </div>
        ))}
      </div>
      <div className="st-token-row">
        <button
          type="button"
          className="st-btn sm"
          onClick={saveKeymap}
          disabled={setKeymap.isPending}
        >
          {setKeymap.isPending ? "저장 중…" : "단축키 저장"}
        </button>
        <button
          type="button"
          className="st-btn-ghost sm"
          onClick={resetKm}
          disabled={resetKeymap.isPending}
        >
          기본값으로 리셋
        </button>
      </div>
      <div className="st-hint">
        단일 키(<code>1</code>) 또는 시퀀스(<code>g b</code> = g 누른 뒤 b). 빈 칸은 그 뷰의
        단축키를 끕니다. 입력란에 포커스가 있을 땐 적용되지 않습니다.
      </div>

      {hotkey.isError && <div className="st-err">{String(hotkey.error)}</div>}
    </div>
  );
}
