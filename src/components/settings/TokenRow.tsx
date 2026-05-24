import { useState } from "react";
import { ChevronRight, Github } from "lucide-react";

import type { TokenKind } from "@/bindings";
import {
  useDeleteProjectToken,
  useGhAuthLoginWeb,
  useGhCliStatus,
  useImportGithubToken,
  useImportNotionToken,
  useNtnCliStatus,
  useNtnLogin,
  usePingProjectToken,
  useSetProjectToken,
} from "@/lib/query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusDot } from "./kit";

/** Notion 마크 (lucide에 브랜드 아이콘이 없어 작은 글리프). */
function NotionGlyph() {
  return (
    <span className="grid size-4 place-items-center rounded bg-foreground text-[9px] font-bold text-background">
      N
    </span>
  );
}

/**
 * 토큰 한 줄 (Notion / GitHub).
 * INVARIANT: 토큰 평문은 **로컬 입력 상태에만** 잠시 머물고, 저장(IPC) 직후 비운다.
 * 1차 어포던스 = gh/ntn CLI에서 '가져오기'(이미 로그인된 CLI에서 keychain으로). 붙여넣기는 고급 fallback.
 */
export function TokenRow({
  projectId,
  kind,
  label,
  hasToken,
  onToast,
}: {
  projectId: string;
  kind: TokenKind;
  label: string;
  hasToken: boolean;
  onToast: (msg: string) => void;
}) {
  const [token, setToken] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const setTok = useSetProjectToken();
  const delTok = useDeleteProjectToken();
  const ping = usePingProjectToken();

  const save = () => {
    const t = token.trim();
    if (!t || setTok.isPending) return;
    setTok.mutate(
      { projectId, kind, token: t },
      {
        onSuccess: () => {
          setToken("");
          onToast(`${label} 토큰 저장됨 (keychain)`);
        },
      },
    );
  };

  const clear = () => {
    delTok.mutate(
      { projectId, kind },
      { onSuccess: () => onToast(`${label} 토큰 삭제됨`) },
    );
  };

  const result = ping.data;

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          {kind === "github" ? <Github className="size-4" /> : <NotionGlyph />}
          <span className="text-sm font-medium">{label}</span>
          <StatusDot on={hasToken}>{hasToken ? "설정됨" : "미설정"}</StatusDot>
        </div>
        {hasToken && (
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => ping.mutate({ projectId, kind })}
              disabled={ping.isPending}
              title="토큰으로 API ping"
            >
              {ping.isPending ? "확인 중…" : "Test ping"}
            </Button>
            <Button
              variant="destructiveOutline"
              size="sm"
              onClick={clear}
              disabled={delTok.isPending}
            >
              삭제
            </Button>
          </div>
        )}
      </div>

      {/* 1차 어포던스: gh/ntn에서 가져오기 (이미 로그인된 CLI 사용) */}
      <CliImportRow
        projectId={projectId}
        kind={kind}
        label={label}
        hasToken={hasToken}
        onToast={onToast}
      />

      {/* advanced fallback: 직접 붙여넣기 */}
      <div className="border-t border-border px-4 py-2.5">
        <button
          type="button"
          onClick={() => setShowPaste((v) => !v)}
          aria-expanded={showPaste}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronRight
            className={`size-3 transition-transform ${showPaste ? "rotate-90" : ""}`}
          />
          직접 붙여넣기 (고급)
        </button>
        {showPaste && (
          <div className="mt-2.5 flex items-center gap-2">
            <Input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              placeholder={hasToken ? "새 토큰으로 교체…" : `${label} 토큰 붙여넣기`}
              className="font-mono"
            />
            <Button
              size="sm"
              className="shrink-0"
              onClick={save}
              disabled={!token.trim() || setTok.isPending}
            >
              저장
            </Button>
          </div>
        )}
      </div>

      {ping.isError && (
        <div className="border-t border-border px-4 py-2.5 text-xs text-[color:var(--destructive)]">
          {String(ping.error)}
        </div>
      )}
      {result && (
        <div
          className={`border-t border-border px-4 py-2.5 text-xs ${
            result.ok ? "text-[color:var(--success)]" : "text-[color:var(--destructive)]"
          }`}
        >
          {result.ok ? "✓ " : "✗ "}
          {result.detail}
        </div>
      )}
    </div>
  );
}

/**
 * gh/ntn CLI에서 토큰 가져오기 (1차 어포던스). 설치/로그인 상태 + 가져오기/로그인 런처.
 * INVARIANT: 토큰 본문은 Rust 안에서만 — 이 컴포넌트는 토큰을 다루지 않는다.
 */
function CliImportRow({
  projectId,
  kind,
  label,
  hasToken,
  onToast,
}: {
  projectId: string;
  kind: TokenKind;
  label: string;
  hasToken: boolean;
  onToast: (msg: string) => void;
}) {
  if (kind === "google_calendar") return null;
  return kind === "github" ? (
    <GithubImportRow
      projectId={projectId}
      label={label}
      hasToken={hasToken}
      onToast={onToast}
    />
  ) : (
    <NotionImportRow
      projectId={projectId}
      label={label}
      hasToken={hasToken}
      onToast={onToast}
    />
  );
}

/** CLI 상태 + 액션을 한 줄로 묶는 공용 레이아웃. */
function ImportShell({
  hint,
  action,
  error,
}: {
  hint: string;
  action: React.ReactNode;
  error?: React.ReactNode;
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5">
        <span className="text-xs text-muted-foreground">{hint}</span>
        {action}
      </div>
      {error}
    </>
  );
}

function GithubImportRow({
  projectId,
  label,
  hasToken,
  onToast,
}: {
  projectId: string;
  label: string;
  hasToken: boolean;
  onToast: (msg: string) => void;
}) {
  const status = useGhCliStatus();
  const importTok = useImportGithubToken();
  const login = useGhAuthLoginWeb();

  const installed = status.data?.installed ?? false;
  const loggedIn = status.data?.loggedIn ?? false;

  const doImport = () =>
    importTok.mutate(projectId, {
      onSuccess: () => onToast(`${label} 토큰 가져옴 (gh → keychain)`),
    });
  const doLogin = () =>
    login.mutate(undefined, {
      onSuccess: () =>
        onToast("브라우저에서 gh 로그인을 완료한 뒤 '가져오기'를 누르세요"),
    });

  const hint = status.isLoading
    ? "gh CLI 상태 확인 중…"
    : (status.data?.detail ?? "gh CLI 상태를 확인할 수 없습니다.");

  return (
    <ImportShell
      hint={hint}
      action={
        installed && loggedIn ? (
          <Button size="sm" onClick={doImport} disabled={importTok.isPending} title="gh auth token → keychain">
            {importTok.isPending ? "가져오는 중…" : hasToken ? "gh에서 다시 가져오기" : "gh에서 가져오기"}
          </Button>
        ) : installed && !loggedIn ? (
          <Button variant="outline" size="sm" onClick={doLogin} disabled={login.isPending} title="gh auth login --web">
            {login.isPending ? "로그인 실행…" : "gh 로그인"}
          </Button>
        ) : null
      }
      error={
        (importTok.isError || login.isError) && (
          <div className="border-t border-border px-4 py-2.5 text-xs text-[color:var(--destructive)]">
            {String(importTok.error ?? login.error)}
          </div>
        )
      }
    />
  );
}

function NotionImportRow({
  projectId,
  label,
  hasToken,
  onToast,
}: {
  projectId: string;
  label: string;
  hasToken: boolean;
  onToast: (msg: string) => void;
}) {
  const status = useNtnCliStatus();
  const importTok = useImportNotionToken();
  const login = useNtnLogin();

  const installed = status.data?.installed ?? false;
  const loggedIn = status.data?.loggedIn ?? false;

  const doImport = () =>
    importTok.mutate(projectId, {
      onSuccess: () => onToast(`${label} 토큰 가져옴 (ntn → keychain)`),
    });
  const doLogin = () =>
    login.mutate(undefined, {
      onSuccess: () =>
        onToast("터미널에서 ntn 로그인을 완료한 뒤 '가져오기'를 누르세요"),
    });

  const hint = status.isLoading
    ? "ntn CLI 상태 확인 중…"
    : (status.data?.detail ?? "ntn CLI 상태를 확인할 수 없습니다.");

  return (
    <ImportShell
      hint={hint}
      action={
        installed && loggedIn ? (
          <Button size="sm" onClick={doImport} disabled={importTok.isPending} title="ntn 토큰 → keychain">
            {importTok.isPending ? "가져오는 중…" : hasToken ? "ntn에서 다시 가져오기" : "ntn에서 가져오기"}
          </Button>
        ) : installed && !loggedIn ? (
          <Button variant="outline" size="sm" onClick={doLogin} disabled={login.isPending} title="ntn login">
            {login.isPending ? "로그인 실행…" : "ntn 로그인"}
          </Button>
        ) : null
      }
      error={
        (importTok.isError || login.isError) && (
          <div className="border-t border-border px-4 py-2.5 text-xs text-[color:var(--destructive)]">
            {String(importTok.error ?? login.error)}
          </div>
        )
      }
    />
  );
}
