import { Archive, Download, Plus, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import type { SkillProvider } from "@/bindings";
import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import {
  useApplySkillUpdate,
  useBackupSkillLibrary,
  useCheckSkillUpdates,
  useCreateSkill,
  useInstallSkillFromGit,
  useRestoreSkillLibrary,
  useSetSkillAutoUpdate,
  useSetSkillUpdateOnLaunch,
  useSkillAudit,
  useSkillBackups,
  useSkillEnvironments,
  useSkillUpdateOnLaunch,
  useSkillUpdateStatus,
  useSkillWorkspaces,
  useVendorSkillToProject,
} from "@/lib/query";
import { buildInstallProviderOptions, VENDORABLE_PROVIDERS } from "@/lib/skillEnvNav";

/** radix Select는 빈 문자열 value를 금지 → "미바인딩"을 센티넬로 표현(write 시 빈 문자열로 정규화). */
const BIND_NONE = "__none__";

/** 인앱 프롬프트 추가 패널. binding은 닫힌 세트(또는 미바인딩). */
export function CreatePanel({ onDone }: { onDone: (id: string | null) => void }) {
  const create = useCreateSkill();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [binding, setBinding] = useState<string>("");
  const [note, setNote] = useState<string | null>(null);

  const submit = () => {
    if (create.isPending) return;
    setNote(null);
    create.mutate(
      { name, prompt, binding: binding || null },
      {
        onSuccess: (s) => onDone(s.id),
        onError: (e) => setNote(`추가 실패: ${(e as Error).message}`),
      },
    );
  };

  return (
    <div className="skl-edit">
      <div className="skl-edit-top">
        <Input
          className="flex-1 font-semibold"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="스킬 이름"
          aria-label="새 스킬 이름"
        />
        <Select
          value={binding || BIND_NONE}
          onValueChange={(v) => setBinding(v === BIND_NONE ? "" : v)}
        >
          <SelectTrigger className="w-auto min-w-[140px] font-mono" aria-label="잡 바인딩">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={BIND_NONE}>미바인딩</SelectItem>
            <SelectItem value="enrich">enrich</SelectItem>
            <SelectItem value="batch_enrich">batch_enrich</SelectItem>
            <SelectItem value="ci_triage">ci_triage</SelectItem>
            <SelectItem value="pr_selfcheck">pr_selfcheck</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Textarea
        className="min-h-[320px] resize-y font-mono leading-relaxed"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="프롬프트 템플릿…"
        spellCheck={false}
        aria-label="새 프롬프트 템플릿"
      />
      <div className="skl-actions">
        <Button
          className="gap-1.5 rounded-full"
          onClick={submit}
          disabled={!name.trim() || !prompt.trim() || create.isPending}
        >
          <Plus className="size-4" />
          {create.isPending ? "추가 중…" : "추가"}
        </Button>
        <Button variant="outline" className="rounded-full" onClick={() => onDone(null)}>
          취소
        </Button>
        {note && <span className="skl-note">{note}</span>}
      </div>
    </div>
  );
}

/** GitHub URL에서 스킬 설치 패널(G1.5-PR1, ADR-0006 레일 ③). URL + provider 선택 → 중앙 라이브러리로
 * 설치(가역·감사). 네트워크/토큰은 Rust(렌더러 비노출). 공개 repo 우선 — 비공개 인증은 후속 라운드.
 * 자동 실행 없음(#1/#2 — tarball 받아 파일 복사일 뿐). */
/** 프로젝트 대상 미선택(라이브러리에만 설치) 센티넬 — radix Select는 빈 문자열 value 금지. */
const PROJECT_NONE = "__library_only__";

export function InstallPanel({ onDone }: { onDone: (id: string | null) => void }) {
  const install = useInstallSkillFromGit();
  const vendor = useVendorSkillToProject();
  // 설치 대상 provider 옵션은 detect로 present인 에이전트만(D5a) — 부재 에이전트는 숨김. "기타"는 항상.
  const environments = useSkillEnvironments();
  // 프로젝트 scope 설치 대상(D5b) — vendoring 가능한 등록 프로젝트(레포). 기존 vendor 인프라 재사용.
  const workspaces = useSkillWorkspaces();
  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState<SkillProvider>("claude");
  // 설치 후 vendor할 프로젝트(레포) id — PROJECT_NONE이면 라이브러리에만 설치.
  const [projectId, setProjectId] = useState<string>(PROJECT_NONE);
  const [note, setNote] = useState<string | null>(null);

  const providerOptions = useMemo(
    () => buildInstallProviderOptions(environments.data),
    [environments.data],
  );
  // 선택된 provider가 더 이상 옵션에 없으면(감지 변동) 첫 옵션으로 보정.
  if (providerOptions.length > 0 && !providerOptions.some((o) => o.provider === provider)) {
    setProvider(providerOptions[0].provider);
  }
  // 프로젝트 scope는 vendoring 가능한 provider(claude/codex) + 등록된 프로젝트가 있을 때만 제공.
  const projectTargets = workspaces.data ?? [];
  const canScopeProject = VENDORABLE_PROVIDERS.has(provider) && projectTargets.length > 0;
  // 선택된 프로젝트가 더 이상 유효하지 않으면(목록 변동/provider 비대상) 라이브러리 전용으로 복귀.
  if (
    projectId !== PROJECT_NONE &&
    (!canScopeProject || !projectTargets.some((w) => w.repoId === projectId))
  ) {
    setProjectId(PROJECT_NONE);
  }

  const submit = () => {
    const u = url.trim();
    if (!u || install.isPending || vendor.isPending) return;
    setNote(null);
    const targetRepo = canScopeProject && projectId !== PROJECT_NONE ? projectId : null;
    install.mutate(
      { url: u, provider },
      {
        onSuccess: (s) => {
          // 라이브러리 전용이면 그대로 완료. 프로젝트 scope면 설치된 managed 스킬을 그 프로젝트
          // dir(.claude|.codex/skills)에 vendor(기존 명령 재사용 — 새 백엔드 테이블 없음). 자동 실행 없음.
          if (!targetRepo || !s.provider) {
            onDone(s.id);
            return;
          }
          vendor.mutate(
            { repoId: targetRepo, provider: s.provider, name: s.name },
            {
              onSuccess: () => onDone(s.id),
              // 설치 자체는 성공 — vendor만 실패. 라이브러리엔 들어갔으니 시트는 그 스킬로 연다.
              onError: (e) => {
                setNote(`라이브러리 설치됨 · 프로젝트 복사 실패: ${(e as Error).message}`);
                onDone(s.id);
              },
            },
          );
        },
        onError: (e) => setNote(`설치 실패: ${(e as Error).message}`),
      },
    );
  };

  const busy = install.isPending || vendor.isPending;

  return (
    <div className="skl-edit">
      <div className="skl-edit-top">
        <Input
          className="flex-1 font-mono"
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="github.com/owner/repo[@ref][#subpath]"
          aria-label="설치할 GitHub repo URL"
        />
        <Select value={provider} onValueChange={(v) => setProvider(v as SkillProvider)}>
          <SelectTrigger className="w-auto min-w-[120px]" aria-label="대상 provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providerOptions.map((o) => (
              <SelectItem key={o.provider} value={o.provider}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {canScopeProject && (
        <div className="skl-install-scope">
          <span className="skl-bind-line">프로젝트에 설치(선택)</span>
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="w-full" aria-label="설치 대상 프로젝트">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={PROJECT_NONE}>라이브러리에만 설치</SelectItem>
              {projectTargets.map((w) => (
                <SelectItem key={w.repoId} value={w.repoId}>
                  {w.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <p className="skl-desc">
        공개 GitHub repo의 스킬을 라이브러리로 설치합니다. 네트워크 호출은 Rust에서 bounded로
        처리되고 모든 쓰기는 감사됩니다.
        {canScopeProject &&
          " 프로젝트를 고르면 설치 후 그 프로젝트의 스킬 dir에도 복사됩니다(가역·감사)."}{" "}
        스킬은 설치만 되며 자동 실행되지 않습니다.
      </p>
      <div className="skl-actions">
        <Button className="gap-1.5 rounded-full" onClick={submit} disabled={!url.trim() || busy}>
          <Download className="size-4" />
          {busy ? "설치 중…" : "설치"}
        </Button>
        <Button variant="outline" className="rounded-full" onClick={() => onDone(null)}>
          취소
        </Button>
        {note && <span className="skl-note">{note}</span>}
      </div>
    </div>
  );
}

/**
 * 백업/복원 패널(G1.5-PR2). 중앙 라이브러리 전체를 타임스탬프 스냅샷으로 백업하고, 스냅샷으로 복원한다.
 * 복원 confirm은 **인라인 2단계**(중첩 Dialog 회피 → Sheet overlay-stack / Esc 계약 무영향). 모든 작업은
 * 로컬 파일 복사 + 감사(잡 비취급 — #1/#2). 복원은 직전 상태를 사전 안전 스냅샷으로 보존하므로 가역.
 */
export function BackupPanel({ onDone }: { onDone: () => void }) {
  const backups = useSkillBackups();
  const backup = useBackupSkillLibrary();
  const restore = useRestoreSkillLibrary();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const doBackup = () => {
    if (backup.isPending) return;
    setNote(null);
    backup.mutate(undefined, {
      onSuccess: (m) => setNote(`백업 완료: ${m.skillCount}개 스킬 (${m.id})`),
      onError: (e) => setNote(`백업 실패: ${(e as Error).message}`),
    });
  };

  const doRestore = (id: string) => {
    if (restore.isPending) return;
    setNote(null);
    restore.mutate(id, {
      onSuccess: () => {
        setConfirmId(null);
        onDone();
      },
      onError: (e) => setNote(`복원 실패: ${(e as Error).message}`),
    });
  };

  return (
    <div className="skl-edit">
      <p className="skl-desc">
        중앙 라이브러리 전체를 타임스탬프 스냅샷으로 백업합니다. 복원은 직전 상태를 안전 스냅샷으로
        보존한 뒤 교체하므로 되돌릴 수 있습니다. 모든 작업은 로컬 파일 복사이며 감사됩니다.
      </p>
      <div className="skl-actions">
        <Button className="gap-1.5 rounded-full" onClick={doBackup} disabled={backup.isPending}>
          <Archive className="size-4" />
          {backup.isPending ? "백업 중…" : "지금 백업"}
        </Button>
        <Button variant="outline" className="rounded-full" onClick={onDone}>
          닫기
        </Button>
      </div>
      {note && <span className="skl-note">{note}</span>}

      <ul className="skl-backup-list">
        {(backups.data ?? []).map((b) => (
          <li key={b.id} className="skl-backup-row">
            <span className="font-mono">{b.createdAt}</span>
            <span className="skl-desc">{b.skillCount}개 스킬</span>
            {confirmId === b.id ? (
              <span className="skl-actions">
                <Button
                  size="sm"
                  className="rounded-full"
                  onClick={() => doRestore(b.id)}
                  disabled={restore.isPending}
                >
                  {restore.isPending ? "복원 중…" : "정말 복원"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full"
                  onClick={() => setConfirmId(null)}
                >
                  취소
                </Button>
              </span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="rounded-full"
                onClick={() => setConfirmId(b.id)}
              >
                복원…
              </Button>
            )}
          </li>
        ))}
        {backups.data?.length === 0 && <li className="skl-desc">아직 백업이 없습니다.</li>}
      </ul>
    </div>
  );
}

/**
 * 감사 로그 뷰어(G1, ADR-0006 레일 ①). append-only `skill_audit_log`를 최근 먼저 표시한다. 읽기 전용 —
 * 중앙 라이브러리에 대한 모든 쓰기(설치·제거·복사·동기화·업데이트) 이력. 자동 실행/적용 없음(#1/#2).
 */
export function AuditPanel({ onDone }: { onDone: () => void }) {
  const audit = useSkillAudit();
  const rows = audit.data ?? [];
  return (
    <div className="skl-edit">
      <p className="skl-desc">
        중앙 라이브러리에 대한 모든 쓰기(설치·제거·복사·동기화·업데이트)를 최근 순으로 기록한
        append-only 감사 로그입니다. 읽기 전용입니다.
      </p>
      <div className="skl-actions">
        <Button variant="outline" className="rounded-full" onClick={onDone}>
          닫기
        </Button>
      </div>
      {audit.isError && (
        <span className="skl-note err">
          감사 로그를 불러오지 못했습니다: {(audit.error as Error).message}
        </span>
      )}
      <ul className="skl-audit-list">
        {rows.map((e) => (
          <li key={e.id} className="skl-audit-row">
            <div className="skl-audit-head">
              <span className="skl-audit-action">{e.action}</span>
              <span className="skl-audit-kind">{e.targetKind}</span>
              <span className="skl-audit-time font-mono">{e.createdAt}</span>
            </div>
            <span className="skl-audit-target font-mono" title={e.targetRef}>
              {e.targetRef}
            </span>
            {e.detail && (
              <span className="skl-audit-detail" title={e.detail}>
                {e.detail}
              </span>
            )}
          </li>
        ))}
        {rows.length === 0 && !audit.isError && <li className="skl-desc">아직 기록이 없습니다.</li>}
      </ul>
    </div>
  );
}

/**
 * 업데이트 패널(G1.5-PR3). 추적 스킬의 업스트림을 확인(fetch-only·bounded·staging만)하고, 새 버전을
 * 적용(사전 전체 백업 후 교체 — 가역)하며, per-skill auto-update와 on-launch opt-in을 토글한다. 적용
 * confirm은 **인라인 2단계**(중첩 Dialog 회피 → Sheet Esc 계약 무영향). 자동 실행/적용 없음(#1/#2).
 */
export function UpdatePanel({ onDone }: { onDone: () => void }) {
  const status = useSkillUpdateStatus();
  const check = useCheckSkillUpdates();
  const setAuto = useSetSkillAutoUpdate();
  const apply = useApplySkillUpdate();
  const onLaunch = useSkillUpdateOnLaunch();
  const setOnLaunch = useSetSkillUpdateOnLaunch();
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const doCheck = () => {
    if (check.isPending) return;
    setNote(null);
    check.mutate(undefined, {
      onSuccess: (rows) => {
        const n = rows.filter((r) => r.updateAvailable).length;
        setNote(n > 0 ? `${n}개 업데이트 가능` : "모두 최신입니다");
      },
      onError: (e) => setNote(`확인 실패: ${(e as Error).message}`),
    });
  };

  const doApply = (provider: SkillProvider, name: string) => {
    if (apply.isPending) return;
    setNote(null);
    apply.mutate(
      { provider, name },
      {
        onSuccess: () => setConfirmKey(null),
        onError: (e) => setNote(`적용 실패: ${(e as Error).message}`),
      },
    );
  };

  const rows = status.data ?? [];
  return (
    <div className="skl-edit">
      <p className="skl-desc">
        설치한 스킬의 업스트림을 확인합니다. 네트워크는 Rust에서 bounded로 처리되고, 새 버전은
        staging에만 받아둡니다 — 적용은 아래에서 직접 누를 때만 일어나며 자동 실행은 없습니다.
      </p>
      <div className="skl-actions">
        <Button className="gap-1.5 rounded-full" onClick={doCheck} disabled={check.isPending}>
          <RefreshCw className="size-4" />
          {check.isPending ? "확인 중…" : "지금 확인"}
        </Button>
        <Button variant="outline" className="rounded-full" onClick={onDone}>
          닫기
        </Button>
      </div>
      <label className="skl-update-launch">
        <Switch checked={!!onLaunch.data} onCheckedChange={(v) => setOnLaunch.mutate(v)} />
        <span className="skl-desc">앱 시작 시 자동 확인(opt-in · 한 번만 · 자동 적용 안 함)</span>
      </label>
      {note && <span className="skl-note">{note}</span>}

      <ul className="skl-backup-list">
        {rows.map((r) => {
          const key = `${r.provider}:${r.name}`;
          return (
            <li key={key} className="skl-backup-row">
              <span className="font-mono">{r.name}</span>
              <div className="skl-update-ctl">
                {r.updateAvailable && <Badge variant="default">업데이트 가능</Badge>}
                <label className="skl-update-toggle">
                  <Switch
                    checked={r.autoUpdate}
                    onCheckedChange={(v) =>
                      setAuto.mutate({
                        provider: r.provider as SkillProvider,
                        name: r.name,
                        enabled: v,
                      })
                    }
                  />
                  <span className="skl-desc">자동</span>
                </label>
                {r.updateAvailable &&
                  (confirmKey === key ? (
                    <>
                      <Button
                        size="sm"
                        className="rounded-full"
                        disabled={apply.isPending}
                        onClick={() => doApply(r.provider as SkillProvider, r.name)}
                      >
                        {apply.isPending ? "적용 중…" : "정말 적용"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="rounded-full"
                        onClick={() => setConfirmKey(null)}
                      >
                        취소
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-full"
                      onClick={() => setConfirmKey(key)}
                    >
                      적용…
                    </Button>
                  ))}
              </div>
            </li>
          );
        })}
        {rows.length === 0 && <li className="skl-desc">설치된(추적 중인) 스킬이 없습니다.</li>}
      </ul>
    </div>
  );
}
