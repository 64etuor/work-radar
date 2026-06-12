import { ChevronRight } from "lucide-react";
import { useReducer, useState } from "react";

import type { AgentPromptConfig, AgentReasoningEffort } from "@/bindings";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useCodexStatus } from "@/lib/query/agents";
import {
  useAgentPromptConfigs,
  useCodexModel,
  useCodexModelCatalog,
  useSetCodexModel,
  useUpdateAgentPromptConfig,
} from "@/lib/query/agentsConfig";
import { useDebouncedCallback } from "@/lib/useDebouncedCallback";

import { SectionLabel, StatusDot } from "./SettingsKit";

type AgentPromptDraft = {
  name: string;
  prompt: string;
  model: string;
  reasoning: AgentReasoningEffort | "inherit";
  fastMode: boolean;
  enabled: boolean;
  promptOpen: boolean;
};

type AgentPromptDraftAction =
  | { type: "name"; value: string }
  | { type: "prompt"; value: string }
  | { type: "model"; value: string }
  | { type: "reasoning"; value: AgentReasoningEffort | "inherit" }
  | { type: "fastMode"; value: boolean }
  | { type: "enabled"; value: boolean }
  | { type: "togglePromptOpen" };

function initAgentPromptDraft(config: AgentPromptConfig): AgentPromptDraft {
  return {
    name: config.name,
    prompt: config.prompt,
    model: config.model ?? "",
    reasoning: config.reasoningEffort ?? "inherit",
    fastMode: config.fastMode,
    enabled: config.enabled,
    promptOpen: false,
  };
}

function agentPromptDraftReducer(
  state: AgentPromptDraft,
  action: AgentPromptDraftAction,
): AgentPromptDraft {
  switch (action.type) {
    case "name":
      return { ...state, name: action.value };
    case "prompt":
      return { ...state, prompt: action.value };
    case "model":
      return { ...state, model: action.value };
    case "reasoning":
      return { ...state, reasoning: action.value };
    case "fastMode":
      return { ...state, fastMode: action.value };
    case "enabled":
      return { ...state, enabled: action.value };
    case "togglePromptOpen":
      return { ...state, promptOpen: !state.promptOpen };
  }
}

/**
 * 에이전트 설정 패널 (B2 Part B).
 * - Codex 설치/인증 상태 표시.
 * - Codex 모델 설정: 자유 입력 + 공통 프리셋. app_config(SQLite) 영속, 비밀 아님.
 * - 미설정이면 codex 기본 동작(모델 플래그 없음).
 */
export function AgentsPane({ onToast }: { onToast: (msg: string) => void }) {
  const status = useCodexStatus();
  const model = useCodexModel();
  const modelCatalog = useCodexModelCatalog();
  const setModel = useSetCodexModel();
  const promptConfigs = useAgentPromptConfigs();

  // 텍스트 입력은 debounce, 프리셋/초기화는 즉시.
  const [draft, setDraft] = useState<string | null>(null);
  const displayValue = draft !== null ? draft : (model.data ?? "");

  const avail = status.data;

  const persist = useDebouncedCallback((value: string | null) => {
    setModel.mutate(value, {
      onSuccess: () => setDraft(null),
      onError: (e) => onToast(String(e)),
    });
  }, 500);

  const onChangeModel = (next: string) => {
    setDraft(next);
    const trimmed = next.trim();
    if (trimmed === (model.data ?? "")) {
      persist.cancel();
      return;
    }
    persist.run(trimmed || null);
  };

  const reset = () => {
    persist.flushNow(null);
    onToast("Codex 모델 기본값으로 초기화됨");
  };

  const presets = modelCatalog.data?.models.map((m) => m.slug) ?? [];

  const statusText =
    avail === undefined
      ? "확인 중…"
      : avail.installed
        ? avail.authed
          ? `설치·로그인됨 (${avail.version ?? ""})`
          : "설치됨 / 미로그인"
        : "미설치";

  return (
    <div className="flex flex-col gap-4">
      {/* Codex 상태 */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">Codex CLI</span>
        <StatusDot on={avail?.installed ?? false}>{statusText}</StatusDot>
      </div>

      {avail && !avail.installed && (
        <p className="text-muted-foreground text-xs">
          codex CLI를 설치하세요: <code>npm install -g @openai/codex</code> 후 재시작.
        </p>
      )}
      {avail && avail.installed && !avail.authed && (
        <p className="text-muted-foreground text-xs">
          <code>codex login</code>을 실행해 인증하세요.
        </p>
      )}
      {avail?.detail && avail.installed && (
        <p className="text-muted-foreground text-xs">{avail.detail}</p>
      )}

      {/* Codex 모델 설정 */}
      <div className="flex flex-col gap-2">
        <SectionLabel>기본 Codex 모델</SectionLabel>
        <div className="flex items-center gap-2">
          <Input
            value={displayValue}
            onChange={(e) => onChangeModel(e.target.value)}
            placeholder="예: gpt-5.5"
            aria-label="Codex 모델"
            className="font-mono"
          />
          {setModel.isPending && (
            <span className="text-muted-foreground shrink-0 text-xs">저장 중…</span>
          )}
          {(model.data || draft) && (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={reset}
              disabled={setModel.isPending}
            >
              초기화
            </Button>
          )}
        </div>
      </div>

      {/* 공통 프리셋 */}
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <Button
            key={p}
            type="button"
            variant="outline"
            size="sm"
            className={cn("font-mono text-[11px]", displayValue === p && "bg-muted")}
            onClick={() => persist.flushNow(p)}
          >
            {p}
          </Button>
        ))}
      </div>

      {modelCatalog.data && (
        <p className="text-muted-foreground typo-caption-sm">
          모델 목록: {modelCatalog.data.source} · {modelCatalog.data.cachedAt}
        </p>
      )}

      <p className="text-muted-foreground text-xs">
        이 값은 내부 프롬프트가 모델을 따로 지정하지 않았을 때 쓰는 fallback입니다. 미설정이면 codex
        CLI 설정을 그대로 상속합니다.
      </p>

      <div className="flex flex-col gap-2 pt-2">
        <SectionLabel>내부 프롬프트별 실행 설정</SectionLabel>
        {promptConfigs.isLoading && (
          <p className="text-muted-foreground text-xs">프롬프트 설정을 불러오는 중…</p>
        )}
        {promptConfigs.data?.map((cfg) => (
          <AgentPromptConfigRow
            key={`${cfg.id}:${cfg.updatedAt}`}
            config={cfg}
            modelOptions={modelCatalog.data?.models.map((m) => m.slug) ?? []}
            onToast={onToast}
          />
        ))}
        {promptConfigs.isError && (
          <p className="text-xs text-[color:var(--destructive)]">{String(promptConfigs.error)}</p>
        )}
      </div>

      {model.isError && (
        <p className="text-xs text-[color:var(--destructive)]">{String(model.error)}</p>
      )}
      {setModel.isError && (
        <p className="text-xs text-[color:var(--destructive)]">{String(setModel.error)}</p>
      )}
    </div>
  );
}

function AgentPromptConfigRow({
  config,
  modelOptions,
  onToast,
}: {
  config: AgentPromptConfig;
  modelOptions: string[];
  onToast: (msg: string) => void;
}) {
  const update = useUpdateAgentPromptConfig();
  const [draft, dispatchDraft] = useReducer(agentPromptDraftReducer, config, initAgentPromptDraft);
  const { name, prompt, model, reasoning, fastMode, enabled, promptOpen } = draft;

  const dirty =
    name !== config.name ||
    prompt !== config.prompt ||
    model !== (config.model ?? "") ||
    reasoning !== (config.reasoningEffort ?? "inherit") ||
    fastMode !== config.fastMode ||
    enabled !== config.enabled;

  const save = () => {
    update.mutate(
      {
        id: config.id,
        name,
        prompt,
        enabled,
        model: model.trim() || null,
        reasoningEffort: reasoning === "inherit" ? null : reasoning,
        fastMode,
      },
      {
        onSuccess: () => onToast(`${name} 실행 설정 저장됨`),
        onError: (e) => onToast(String(e)),
      },
    );
  };

  return (
    <div className="border-border bg-card/40 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => dispatchDraft({ type: "name", value: e.target.value })}
          className="h-8 min-w-48 flex-1"
          aria-label={`${config.binding} 이름`}
        />
        <code className="bg-muted rounded px-2 py-1 text-[11px]">{config.binding}</code>
        <div className="text-muted-foreground ml-auto flex items-center gap-2 text-xs">
          <Switch
            checked={enabled}
            onCheckedChange={(value) => dispatchDraft({ type: "enabled", value })}
            aria-label={`${config.binding} 사용`}
          />
          사용
        </div>
      </div>
      <button
        type="button"
        onClick={() => dispatchDraft({ type: "togglePromptOpen" })}
        aria-expanded={promptOpen}
        className="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-1 text-xs"
      >
        <ChevronRight
          className={`size-3 transition-transform ${promptOpen ? "rotate-90" : ""}`}
          aria-hidden
        />
        프롬프트 {promptOpen ? "접기" : "펼치기"}
      </button>
      {promptOpen && (
        <textarea
          value={prompt}
          onChange={(e) => dispatchDraft({ type: "prompt", value: e.target.value })}
          className="border-input bg-background text-foreground focus:ring-ring mt-2 min-h-24 w-full rounded-md border px-3 py-2 font-mono text-xs outline-none focus:ring-2"
          aria-label={`${config.binding} 프롬프트`}
        />
      )}
      <div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_150px_120px_auto]">
        <Input
          list={`codex-models-${config.id}`}
          value={model}
          onChange={(e) => dispatchDraft({ type: "model", value: e.target.value })}
          placeholder="모델 상속"
          className="h-8 font-mono text-xs"
          aria-label={`${config.binding} 모델`}
        />
        <datalist id={`codex-models-${config.id}`}>
          {modelOptions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
        <Select
          value={reasoning}
          onValueChange={(value) =>
            dispatchDraft({ type: "reasoning", value: value as AgentReasoningEffort | "inherit" })
          }
        >
          <SelectTrigger className="h-8 text-xs" aria-label={`${config.binding} reasoning effort`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">thinking 상속</SelectItem>
            <SelectItem value="low">low</SelectItem>
            <SelectItem value="medium">medium</SelectItem>
            <SelectItem value="high">high</SelectItem>
            <SelectItem value="xhigh">xhigh</SelectItem>
          </SelectContent>
        </Select>
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <Switch
            checked={fastMode}
            onCheckedChange={(value) => dispatchDraft({ type: "fastMode", value })}
            aria-label={`${config.binding} fast 모드`}
          />
          fast
        </div>
        <Button
          size="sm"
          className="h-8 shrink-0"
          disabled={!dirty || update.isPending}
          onClick={save}
        >
          {update.isPending ? "저장 중…" : "저장"}
        </Button>
      </div>
      <p className="text-muted-foreground typo-caption-sm mt-1">
        모델 공란은 기본 모델을 상속합니다. fast는 모델 공란일 때 <code>gpt-5.3-codex-spark</code>로
        실행합니다.
      </p>
    </div>
  );
}
