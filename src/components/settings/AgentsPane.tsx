import { useState } from "react";

import { useCodexStatus } from "@/lib/query/agents";
import {
  useAgentPromptConfigs,
  useCodexModel,
  useCodexModelCatalog,
  useSetCodexModel,
  useUpdateAgentPromptConfig,
} from "@/lib/query/agentsConfig";
import type { AgentPromptConfig, AgentReasoningEffort } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/components/ui/cn";
import { SectionLabel, StatusDot } from "./SettingsKit";

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

  const [draft, setDraft] = useState<string | null>(null);
  // draft가 null이면 서버 값을 표시, 편집 중이면 draft 값.
  const displayValue = draft !== null ? draft : (model.data ?? "");

  const avail = status.data;

  const save = () => {
    const val = (draft ?? "").trim();
    setModel.mutate(val || null, {
      onSuccess: () => {
        setDraft(null);
        onToast(val ? `Codex 모델 설정됨: ${val}` : "Codex 모델 기본값으로 초기화됨");
      },
      onError: (e) => onToast(String(e)),
    });
  };

  const reset = () => {
    setModel.mutate(null, {
      onSuccess: () => {
        setDraft(null);
        onToast("Codex 모델 기본값으로 초기화됨");
      },
      onError: (e) => onToast(String(e)),
    });
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
        <p className="text-xs text-muted-foreground">
          codex CLI를 설치하세요: <code>npm install -g @openai/codex</code> 후 재시작.
        </p>
      )}
      {avail && avail.installed && !avail.authed && (
        <p className="text-xs text-muted-foreground">
          <code>codex login</code>을 실행해 인증하세요.
        </p>
      )}
      {avail?.detail && avail.installed && (
        <p className="text-xs text-muted-foreground">{avail.detail}</p>
      )}

      {/* Codex 모델 설정 */}
      <div className="flex flex-col gap-2">
        <SectionLabel>기본 Codex 모델</SectionLabel>
        <div className="flex items-center gap-2">
          <Input
            value={displayValue}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="예: gpt-5.5"
            aria-label="Codex 모델"
            className="font-mono"
          />
          <Button
            size="sm"
            className="shrink-0"
            onClick={save}
            disabled={
              setModel.isPending ||
              (draft === null || draft.trim() === (model.data ?? ""))
            }
          >
            {setModel.isPending ? "저장 중…" : "저장"}
          </Button>
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
            className={cn(
              "font-mono text-[11px]",
              displayValue === p && "bg-muted",
            )}
            onClick={() => setDraft(p)}
          >
            {p}
          </Button>
        ))}
      </div>

      {modelCatalog.data && (
        <p className="text-[11px] text-muted-foreground">
          모델 목록: {modelCatalog.data.source} · {modelCatalog.data.cachedAt}
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        이 값은 내부 프롬프트가 모델을 따로 지정하지 않았을 때 쓰는 fallback입니다.
        미설정이면 codex CLI 설정을 그대로 상속합니다.
      </p>

      <div className="flex flex-col gap-2 pt-2">
        <SectionLabel>내부 프롬프트별 실행 설정</SectionLabel>
        {promptConfigs.isLoading && (
          <p className="text-xs text-muted-foreground">프롬프트 설정을 불러오는 중…</p>
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
          <p className="text-xs text-[color:var(--destructive)]">
            {String(promptConfigs.error)}
          </p>
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
  const [name, setName] = useState(config.name);
  const [prompt, setPrompt] = useState(config.prompt);
  const [model, setModel] = useState(config.model ?? "");
  const [reasoning, setReasoning] = useState<AgentReasoningEffort | "inherit">(
    config.reasoningEffort ?? "inherit",
  );
  const [fastMode, setFastMode] = useState(config.fastMode);
  const [enabled, setEnabled] = useState(config.enabled);

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
    <div className="rounded-md border border-border bg-card/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 min-w-48 flex-1"
          aria-label={`${config.binding} 이름`}
        />
        <code className="rounded bg-muted px-2 py-1 text-[11px]">{config.binding}</code>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={enabled} onCheckedChange={setEnabled} />
          사용
        </label>
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        className="mt-2 min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono text-foreground outline-none focus:ring-2 focus:ring-ring"
        aria-label={`${config.binding} 프롬프트`}
      />
      <div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_150px_120px_auto]">
        <Input
          list={`codex-models-${config.id}`}
          value={model}
          onChange={(e) => setModel(e.target.value)}
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
          onValueChange={(v) => setReasoning(v as AgentReasoningEffort | "inherit")}
        >
          <SelectTrigger className="h-8 text-xs" aria-label={`${config.binding} thinking`}>
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
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={fastMode} onCheckedChange={setFastMode} />
          fast
        </label>
        <Button
          size="sm"
          className="h-8 shrink-0"
          disabled={!dirty || update.isPending}
          onClick={save}
        >
          {update.isPending ? "저장 중…" : "저장"}
        </Button>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        모델 공란은 기본 모델을 상속합니다. fast는 모델 공란일 때{" "}
        <code>gpt-5.3-codex-spark</code>로 실행합니다.
      </p>
    </div>
  );
}
