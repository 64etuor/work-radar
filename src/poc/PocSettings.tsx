import {
  ArrowLeft,
  Bell,
  Bot,
  Check,
  ChevronRight,
  CircleUserRound,
  FolderGit2,
  FolderOpen,
  Github,
  Keyboard,
  Link2,
  Moon,
  MoreHorizontal,
  Plus,
  Sun,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const CATEGORIES = [
  { id: "projects", label: "프로젝트", icon: FolderOpen },
  { id: "agents", label: "에이전트", icon: Bot },
  { id: "shortcuts", label: "단축키", icon: Keyboard },
  { id: "integrations", label: "통합", icon: Link2 },
  { id: "notifications", label: "알림", icon: Bell },
] as const;

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-subtle font-mono text-[11px] font-semibold tracking-[0.12em] uppercase">
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-foreground text-[13px] font-medium">{label}</label>
      {children}
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </div>
  );
}

/** 연결 상태 점 + 라벨. */
function StatusDot({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium ${
        on ? "text-[color:var(--success)]" : "text-muted-foreground"
      }`}
    >
      <span
        className={`size-1.5 rounded-full ${on ? "bg-[color:var(--success)]" : "bg-border-strong"}`}
      />
      {children}
    </span>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  size?: "md" | "sm";
}) {
  return (
    <div
      className={`border-border bg-muted inline-flex w-fit items-center self-start rounded-lg border p-0.5 ${
        size === "md" ? "h-9" : "h-8"
      }`}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`h-full rounded-md px-3.5 text-[13px] font-medium transition-colors ${
            value === o.value
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function NewProjectCard() {
  const [kind, setKind] = useState<"personal" | "work">("work");
  return (
    <div className="border-border bg-card rounded-xl border">
      <div className="border-border border-b px-5 py-3.5">
        <h3 className="text-sm font-semibold">새 프로젝트</h3>
        <p className="text-muted-foreground mt-0.5 text-xs">
          개인 또는 업무 프로젝트를 추가하고 Notion DB를 연결하세요.
        </p>
      </div>
      <div className="flex flex-col gap-4 p-5">
        <Field label="이름">
          <Input placeholder="예: Mirrorless / 내 삶" defaultValue="Mirrorless" />
        </Field>
        <Field label="종류">
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: "personal", label: "개인" },
              { value: "work", label: "업무" },
            ]}
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Notion 백로그 DB ID" hint="선택 — 백로그 미러링 대상">
            <Input placeholder="데이터베이스 ID" className="font-mono" />
          </Field>
          <Field label="Notion 안건 DB ID" hint="선택 — 안건/회의 미러링 대상">
            <Input placeholder="데이터베이스 ID" className="font-mono" />
          </Field>
        </div>
      </div>
      <div className="border-border flex justify-end border-t px-5 py-3.5">
        <Button>
          <Plus className="size-4" />
          프로젝트 추가
        </Button>
      </div>
    </div>
  );
}

/** 토큰 한 줄 — CLI 가져오기/웹 로그인 1차 + 붙여넣기 고급(접힘). */
function TokenRow({
  icon,
  label,
  cli,
  state,
}: {
  icon: React.ReactNode;
  label: string;
  cli: string;
  state: "set" | "loggedin" | "loggedout";
}) {
  const [paste, setPaste] = useState(false);
  const isSet = state === "set";
  return (
    <div className="border-border rounded-lg border">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          {icon}
          <span className="text-sm font-medium">{label}</span>
          <StatusDot on={isSet}>{isSet ? "설정됨" : "미설정"}</StatusDot>
        </div>
        <div className="flex items-center gap-1.5">
          {isSet ? (
            <>
              <Button variant="outline" size="sm">
                Test ping
              </Button>
              <Button variant="destructiveOutline" size="sm">
                삭제
              </Button>
            </>
          ) : state === "loggedin" ? (
            <Button size="sm">{label === "GitHub" ? "gh에서 가져오기" : "ntn에서 가져오기"}</Button>
          ) : (
            <Button size="sm" variant="outline">
              {label === "GitHub" ? "gh 로그인" : "ntn 로그인"}
            </Button>
          )}
        </div>
      </div>
      <div className="border-border flex items-center justify-between gap-3 border-t px-4 py-2.5">
        <span className="text-muted-foreground text-xs">{cli}</span>
        <button
          type="button"
          onClick={() => setPaste((v) => !v)}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
        >
          <ChevronRight className={`size-3 transition-transform ${paste ? "rotate-90" : ""}`} />
          직접 붙여넣기 (고급)
        </button>
      </div>
      {paste && (
        <div className="border-border flex items-center gap-2 border-t px-4 py-3">
          <Input type="password" placeholder={`${label} 토큰 붙여넣기`} className="font-mono" />
          <Button size="sm" className="shrink-0">
            저장
          </Button>
        </div>
      )}
    </div>
  );
}

function GoogleAccountRow() {
  return (
    <div className="border-border rounded-lg border">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <CircleUserRound className="text-muted-foreground size-4" />
          <span className="text-sm font-medium">Google 계정</span>
          <StatusDot on>계정 연결됨</StatusDot>
          <Badge variant="outline">calendar</Badge>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm">
            Test 연결
          </Button>
          <Button variant="destructiveOutline" size="sm">
            연결 해제
          </Button>
        </div>
      </div>
      <div className="border-border flex flex-col gap-2 border-t px-4 py-3">
        <SectionLabel>포함할 캘린더</SectionLabel>
        {[
          ["yangha@mirrorless.co.kr", true],
          ["팀 일정", true],
          ["개인", false],
        ].map(([name, on]) => (
          <label key={name as string} className="flex items-center gap-2.5 text-sm">
            <span
              className={`flex size-4 items-center justify-center rounded border ${
                on ? "border-primary bg-primary text-primary-foreground" : "border-input"
              }`}
            >
              {on ? <Check className="size-3" /> : null}
            </span>
            {name}
          </label>
        ))}
      </div>
    </div>
  );
}

function RepoRow({
  provider,
  loc,
  branch,
}: {
  provider: "github" | "local";
  loc: string;
  branch: string;
}) {
  return (
    <div className="border-border flex items-center gap-3 rounded-lg border px-3.5 py-2.5">
      {provider === "github" ? (
        <Github className="text-muted-foreground size-4 shrink-0" />
      ) : (
        <FolderGit2 className="text-muted-foreground size-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{loc}</span>
      <Badge variant="outline">{branch}</Badge>
    </div>
  );
}

function ProjectCard({
  name,
  kind,
  expanded,
}: {
  name: string;
  kind: "personal" | "work";
  expanded: boolean;
}) {
  return (
    <div className="border-border bg-card rounded-xl border">
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="bg-muted flex size-9 items-center justify-center rounded-lg">
          <FolderOpen className="text-muted-foreground size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{name}</span>
            <Badge variant={kind === "work" ? "accent" : "secondary"}>
              {kind === "work" ? "업무" : "개인"}
            </Badge>
          </div>
          <span className="text-muted-foreground text-xs">
            {expanded ? "토큰·캘린더·레포 1개 연결됨" : "미연결"}
          </span>
        </div>
        <Button variant="ghost" size="sm" className="size-8 px-0">
          <MoreHorizontal className="size-4" />
        </Button>
      </div>

      {expanded && (
        <div className="border-border flex flex-col gap-5 border-t px-5 py-5">
          <div className="flex flex-col gap-2.5">
            <SectionLabel>토큰 · keychain</SectionLabel>
            <TokenRow
              icon={
                <span className="bg-foreground text-background grid size-4 place-items-center rounded text-[9px] font-bold">
                  N
                </span>
              }
              label="Notion"
              cli="ntn CLI · 로그인됨"
              state="set"
            />
            <TokenRow
              icon={<Github className="size-4" />}
              label="GitHub"
              cli="gh CLI · 미로그인"
              state="loggedout"
            />
          </div>

          <div className="flex flex-col gap-2.5">
            <SectionLabel>Google 계정</SectionLabel>
            <GoogleAccountRow />
          </div>

          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <SectionLabel>레포</SectionLabel>
              <Button variant="outline" size="sm">
                <Plus className="size-3.5" />
                레포 추가
              </Button>
            </div>
            <RepoRow provider="github" loc="github.com/mirrorless/mono" branch="main" />
            <RepoRow provider="local" loc="~/private_project/work-radar" branch="dev" />
          </div>
        </div>
      )}
    </div>
  );
}

export function PocSettings() {
  const [dark, setDark] = useState(false);
  const [cat, setCat] = useState<(typeof CATEGORIES)[number]["id"]>("projects");

  return (
    <div className={`${dark ? "dark" : ""}min-h-screen bg-background text-foreground`}>
      <header className="border-border flex items-center gap-3 border-b px-5 py-3">
        <button className="border-border hover:bg-muted inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium">
          <ArrowLeft className="size-4" />
          보드
        </button>
        <span className="font-mono text-[13px] font-semibold tracking-[0.12em] uppercase">
          설정
        </span>
        <button
          onClick={() => setDark((d) => !d)}
          className="border-border hover:bg-muted ml-auto inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium"
        >
          {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          {dark ? "라이트" : "다크"}
        </button>
      </header>

      <div className="mx-auto flex max-w-5xl gap-8 px-6 py-7">
        <nav className="flex w-44 shrink-0 flex-col gap-0.5">
          {CATEGORIES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setCat(id)}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${
                cat === id
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-hover hover:text-foreground"
              }`}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>

        <main className="flex min-w-0 flex-1 flex-col gap-6">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">프로젝트</h2>
            <p className="text-muted-foreground mt-0.5 text-sm">
              개인/업무 프로젝트와 Notion·GitHub·Google 계정 연결을 관리합니다.
            </p>
          </div>

          <NewProjectCard />

          <div className="flex flex-col gap-3">
            <SectionLabel>프로젝트 (2)</SectionLabel>
            <ProjectCard name="Mirrorless" kind="work" expanded />
            <ProjectCard name="내 삶" kind="personal" expanded={false} />
          </div>
        </main>
      </div>
    </div>
  );
}
