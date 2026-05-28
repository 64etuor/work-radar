import type { DiffFileSummary, DiffMode, FileChange } from "@/bindings";
import { Spinner } from "@/components/Spinner";
import { cn } from "@/components/ui/cn";

export type SelectedDiff = {
  path: string;
  mode: DiffMode;
};

const SOURCE_LABEL: Record<DiffMode, string> = {
  working: "unstaged",
  staged: "staged",
  vs_base: "branch",
  branch_branch: "compare",
};

const FILE_STATUS_LABEL: Record<FileChange, string> = {
  M: "수정",
  A: "추가",
  D: "삭제",
  R: "이름변경",
};

export function LocalFileSections({
  stagedFiles,
  unstagedFiles,
  stagedLoading,
  unstagedLoading,
  stagedError,
  unstagedError,
  selectedDiff,
  onSelect,
}: {
  stagedFiles: DiffFileSummary[];
  unstagedFiles: DiffFileSummary[];
  stagedLoading: boolean;
  unstagedLoading: boolean;
  stagedError: Error | null;
  unstagedError: Error | null;
  selectedDiff: SelectedDiff | null;
  onSelect: (next: SelectedDiff) => void;
}) {
  const loading = stagedLoading || unstagedLoading;
  if (loading) {
    return (
      <div className="wt-empty">
        <Spinner />
      </div>
    );
  }
  if (stagedError || unstagedError) {
    return (
      <div className="wt-err">
        {(stagedError ?? unstagedError)?.message ?? "diff 파일 목록을 불러오지 못했습니다."}
      </div>
    );
  }
  if (stagedFiles.length === 0 && unstagedFiles.length === 0) {
    return <div className="wt-empty">로컬 staged/unstaged 변경이 없습니다.</div>;
  }
  return (
    <>
      <FileSection
        title="Staged"
        description="index vs HEAD"
        mode="staged"
        files={stagedFiles}
        selectedDiff={selectedDiff}
        onSelect={onSelect}
      />
      <FileSection
        title="Unstaged"
        description="working tree vs index"
        mode="working"
        files={unstagedFiles}
        selectedDiff={selectedDiff}
        onSelect={onSelect}
      />
    </>
  );
}

function FileSection({
  title,
  description,
  mode,
  files,
  selectedDiff,
  onSelect,
}: {
  title: string;
  description: string;
  mode: DiffMode;
  files: DiffFileSummary[];
  selectedDiff: SelectedDiff | null;
  onSelect: (next: SelectedDiff) => void;
}) {
  return (
    <section className="wt-file-section">
      <div className="wt-file-section-head">
        <span>{title}</span>
        <em>{description}</em>
      </div>
      {files.length === 0 ? (
        <div className="wt-file-section-empty">이 bucket에는 파일이 없습니다.</div>
      ) : (
        files.map((f) => (
          <FileRow
            key={`${mode}:${f.path}`}
            file={f}
            source={mode}
            active={selectedDiff?.path === f.path && selectedDiff.mode === mode}
            onSelect={() => onSelect({ path: f.path, mode })}
          />
        ))
      )}
    </section>
  );
}

export function FileRow({
  file,
  source,
  active,
  onSelect,
}: {
  file: DiffFileSummary;
  source: DiffMode;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={cn("wt-file", active && "wt-file-on")} onClick={onSelect}>
      <span className={`wt-fstatus wt-fs-${file.status}`} title={FILE_STATUS_LABEL[file.status]}>
        {file.status}
      </span>
      <span className={`wt-source wt-source-${source}`}>{SOURCE_LABEL[source]}</span>
      <span className="wt-fpath">
        {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      </span>
      {file.binary ? (
        <span className="wt-fbin">bin</span>
      ) : (
        <span className="wt-fstat">
          <span className="wt-adds">+{file.adds}</span>
          <span className="wt-dels">−{file.dels}</span>
        </span>
      )}
    </button>
  );
}
