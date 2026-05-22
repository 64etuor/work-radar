import { useState } from "react";

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

/**
 * 토큰 한 줄 (Notion / GitHub).
 * INVARIANT: 토큰 평문은 **로컬 입력 상태에만** 잠시 머물고, 저장(IPC) 직후 비운다.
 * query/zustand 캐시·백엔드 반환 어디에도 토큰 본문을 두지 않는다. 상태는 boolean(hasToken)만.
 *
 * Phase 14: gh/ntn CLI에서 '가져오기'가 1차 어포던스 — 이미 로그인된 CLI에서 토큰을 읽어
 * keychain에 저장(토큰은 Rust 안에서만 흐름). 붙여넣기는 advanced fallback로 접어둔다.
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
          setToken(""); // 즉시 비움 — 평문 미보관.
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
    <div className="st-token">
      <div className="st-token-head">
        <span className="st-token-lbl">{label}</span>
        <span className={hasToken ? "st-status on" : "st-status"}>
          {hasToken ? "● 설정됨" : "○ 미설정"}
        </span>
      </div>

      {/* 1차 어포던스: gh/ntn에서 가져오기 (이미 로그인된 CLI 사용) */}
      <CliImportRow
        projectId={projectId}
        kind={kind}
        label={label}
        hasToken={hasToken}
        onToast={onToast}
      />

      {/* keychain 토큰이 있으면 Test ping / 삭제는 항상 노출 */}
      {hasToken && (
        <div className="st-token-row">
          <button
            type="button"
            className="st-btn-ghost sm"
            onClick={() => ping.mutate({ projectId, kind })}
            disabled={ping.isPending}
            title="토큰으로 API ping"
          >
            {ping.isPending ? "확인 중…" : "Test ping"}
          </button>
          <button
            type="button"
            className="st-btn-ghost sm"
            onClick={clear}
            disabled={delTok.isPending}
          >
            삭제
          </button>
        </div>
      )}

      {/* advanced fallback: 직접 붙여넣기 (CLI 미설치/특수 토큰 대비) */}
      <button
        type="button"
        className="st-disclosure"
        onClick={() => setShowPaste((v) => !v)}
        aria-expanded={showPaste}
      >
        {showPaste ? "▾ 직접 붙여넣기 숨기기" : "▸ 직접 붙여넣기 (고급)"}
      </button>
      {showPaste && (
        <div className="st-token-row">
          <input
            className="st-input"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            placeholder={hasToken ? "새 토큰으로 교체…" : `${label} 토큰 붙여넣기`}
          />
          <button
            type="button"
            className="st-btn sm"
            onClick={save}
            disabled={!token.trim() || setTok.isPending}
          >
            저장
          </button>
        </div>
      )}

      {ping.isError && <div className="st-err">{String(ping.error)}</div>}
      {result && (
        <div className={result.ok ? "st-ping ok" : "st-ping fail"}>
          {result.ok ? "✓ " : "✗ "}
          {result.detail}
        </div>
      )}
    </div>
  );
}

/**
 * gh/ntn CLI에서 토큰 가져오기 (1차 어포던스). 설치/로그인 상태를 보여주고:
 *  - 로그인됨 → '가져오기' (gh auth token / ntn file-auth → keychain)
 *  - 미로그인 → '로그인' 런처 (gh auth login --web / ntn login)
 *  - 미설치 → 붙여넣기 fallback 안내
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
  // GoogleCalendar는 자체 OAuth 플로우(GoogleCalendarBlock) — CLI import 대상 아님.
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
        onToast("터미널/브라우저에서 gh 로그인을 완료한 뒤 '가져오기'를 누르세요"),
    });

  return (
    <div className="st-import">
      <div className="st-token-row">
        {installed && loggedIn && (
          <button
            type="button"
            className="st-btn sm"
            onClick={doImport}
            disabled={importTok.isPending}
            title="gh auth token → keychain"
          >
            {importTok.isPending
              ? "가져오는 중…"
              : hasToken
                ? "gh에서 다시 가져오기"
                : "gh에서 가져오기"}
          </button>
        )}
        {installed && !loggedIn && (
          <button
            type="button"
            className="st-btn sm"
            onClick={doLogin}
            disabled={login.isPending}
            title="gh auth login --web"
          >
            {login.isPending ? "로그인 실행…" : "gh 로그인"}
          </button>
        )}
      </div>
      <div className="st-hint">
        {status.isLoading
          ? "gh CLI 상태 확인 중…"
          : (status.data?.detail ?? "gh CLI 상태를 확인할 수 없습니다.")}
      </div>
      {importTok.isError && (
        <div className="st-err">{String(importTok.error)}</div>
      )}
      {login.isError && <div className="st-err">{String(login.error)}</div>}
    </div>
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

  return (
    <div className="st-import">
      <div className="st-token-row">
        {installed && loggedIn && (
          <button
            type="button"
            className="st-btn sm"
            onClick={doImport}
            disabled={importTok.isPending}
            title="ntn 토큰 → keychain"
          >
            {importTok.isPending
              ? "가져오는 중…"
              : hasToken
                ? "ntn에서 다시 가져오기"
                : "ntn에서 가져오기"}
          </button>
        )}
        {installed && !loggedIn && (
          <button
            type="button"
            className="st-btn sm"
            onClick={doLogin}
            disabled={login.isPending}
            title="ntn login"
          >
            {login.isPending ? "로그인 실행…" : "ntn 로그인"}
          </button>
        )}
      </div>
      <div className="st-hint">
        {status.isLoading
          ? "ntn CLI 상태 확인 중…"
          : (status.data?.detail ?? "ntn CLI 상태를 확인할 수 없습니다.")}
      </div>
      {importTok.isError && (
        <div className="st-err">{String(importTok.error)}</div>
      )}
      {login.isError && <div className="st-err">{String(login.error)}</div>}
    </div>
  );
}
