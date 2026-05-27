import { X } from "lucide-react";
import { Fragment, useEffect } from "react";

import type { CommitGraph, Worktree } from "@/bindings";
import { Spinner } from "@/components/Spinner";
import { registerOverlay } from "@/components/ui/overlay-stack";
import { useWorktreeCommitGraph } from "@/lib/query";
import { computeGraphTopology, type GraphTopologyRow } from "@/lib/worktreeReview";

export function CommitGraphDrawer({
  worktree,
  baseRef,
  onClose,
}: {
  worktree: Worktree;
  baseRef: string;
  onClose: () => void;
}) {
  const graph = useWorktreeCommitGraph({
    worktreePath: worktree.path,
    baseRef,
    open: true,
  });

  useEffect(() => {
    const unregister = registerOverlay();
    const trigger = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      unregister();
      trigger?.focus?.();
    };
  }, [onClose]);

  return (
    <aside className="wt-commit-drawer" role="dialog" aria-label="커밋 그래프">
      <header className="wt-commit-head">
        <div>
          <span className="wt-commit-kicker">Commit graph</span>
          <h3>{worktree.branch ?? "detached"}</h3>
          <p>{baseRef}...HEAD</p>
        </div>
        <button
          type="button"
          className="wt-commit-close"
          aria-label="커밋 그래프 닫기"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </header>

      {graph.isFetching ? (
        <div className="wt-commit-state">
          <Spinner />
          <span>커밋 그래프 로드 중…</span>
        </div>
      ) : graph.error ? (
        <div className="wt-err">{(graph.error as Error).message}</div>
      ) : (
        <CommitGraphBody graph={graph.data} />
      )}
    </aside>
  );
}

const LANE_WIDTH = 16;
const ROW_HEIGHT = 28;
const MID_Y = ROW_HEIGHT / 2;
const NODE_RADIUS = 4.5;
const laneCenter = (l: number) => l * LANE_WIDTH + LANE_WIDTH / 2;

function CommitGraphBody({ graph }: { graph: CommitGraph | undefined }) {
  if (!graph) return <div className="wt-commit-state">커밋 그래프가 없습니다.</div>;

  if (graph.commits.length === 0) {
    return (
      <div className="wt-commit-body">
        <section className="wt-commit-table" aria-label="commit graph">
          <div className="wt-commit-table-meta">
            <span>차이 없음</span>
            <strong>verified</strong>
          </div>
          <div className="wt-commit-empty">base와 HEAD 사이 커밋 차이가 없습니다.</div>
        </section>
      </div>
    );
  }

  const topology = computeGraphTopology(graph.commits);
  const graphWidth = topology.maxLanes * LANE_WIDTH + 8;
  const totalHeight = graph.commits.length * ROW_HEIGHT;

  return (
    <div className="wt-commit-body">
      <section
        className="wt-commit-table"
        aria-label="commit graph"
        style={{ ["--wt-graph-w" as never]: `${graphWidth}px` }}
      >
        <div className="wt-commit-table-meta">
          <span>
            {graph.commits.length} commit{graph.commits.length === 1 ? "" : "s"}
          </span>
          {graph.truncated ? <strong>최근 80개만</strong> : <strong>verified</strong>}
        </div>
        <div className="wt-commit-table-scroll">
          <div className="wt-commit-grid" role="grid" aria-label="commit grid">
            <div className="wt-h wt-h-graph" role="columnheader">
              Graph
            </div>
            <div className="wt-h wt-h-commit" role="columnheader">
              Commit
            </div>
            <div className="wt-h wt-h-author" role="columnheader">
              Author
            </div>
            <div className="wt-h wt-h-date" role="columnheader">
              Date
            </div>

            <GraphCanvas
              rows={topology.rows}
              commits={graph.commits}
              width={graphWidth}
              height={totalHeight}
            />

            {graph.commits.map((commit, idx) => {
              const gridRow = idx + 2;
              return (
                <Fragment key={commit.hash}>
                  <div
                    className={`wt-c wt-c-commit wt-c-side-${commit.side}`}
                    style={{ gridRow }}
                    role="cell"
                    title={commit.subject}
                  >
                    <code className="wt-commit-hash">{commit.shortHash}</code>
                    <span className="wt-commit-subject">{commit.subject}</span>
                  </div>
                  <div
                    className="wt-c wt-c-author"
                    style={{ gridRow }}
                    role="cell"
                    title={commit.author}
                  >
                    {commit.author}
                  </div>
                  <div className="wt-c wt-c-date" style={{ gridRow }} role="cell">
                    {commit.date}
                  </div>
                </Fragment>
              );
            })}
          </div>
        </div>
      </section>

      <section className="wt-commit-detail" aria-label="commit messages">
        <div className="wt-commit-table-meta">
          <span>Commit messages</span>
          <strong>{graph.commits.length}</strong>
        </div>
        <ol className="wt-commit-detail-list">
          {graph.commits.map((commit) => (
            <li key={commit.hash} className={`wt-commit-card wt-commit-card-${commit.side}`}>
              <code className="wt-commit-card-hash">{commit.shortHash}</code>
              <div className="wt-commit-card-body">
                <h4 className="wt-commit-card-subject">{commit.subject}</h4>
                <p className="wt-commit-card-meta">
                  <span>{commit.author}</span>
                  <span aria-hidden="true">·</span>
                  <span>{commit.date}</span>
                </p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function GraphCanvas({
  rows,
  commits,
  width,
  height,
}: {
  rows: GraphTopologyRow[];
  commits: { shortHash: string }[];
  width: number;
  height: number;
}) {
  const segments: React.ReactNode[] = [];
  const nodes: React.ReactNode[] = [];

  rows.forEach((row, rowIdx) => {
    const top = rowIdx * ROW_HEIGHT;
    const mid = top + MID_Y;
    const bottom = top + ROW_HEIGHT;
    const nodeX = laneCenter(row.laneNode);
    const shortHash = commits[rowIdx].shortHash;
    const colorClass = (l: number) => `wt-commit-lane-${row.laneColors[l] ?? 0}`;

    row.lanesAbove.forEach((hash, l) => {
      if (hash === null) return;
      const xl = laneCenter(l);
      const cls = `wt-commit-visual-line ${colorClass(l)}`;
      if (hash === shortHash) {
        if (l === row.laneNode) {
          segments.push(
            <line key={`u-s-${rowIdx}-${l}`} className={cls} x1={xl} y1={top} x2={xl} y2={mid} />,
          );
        } else {
          const dx = nodeX - xl;
          segments.push(
            <path
              key={`u-c-${rowIdx}-${l}`}
              className={cls}
              d={`M ${xl} ${top} C ${xl} ${top + MID_Y * 0.55}, ${xl + dx * 0.45} ${mid}, ${nodeX} ${mid}`}
            />,
          );
        }
      } else {
        segments.push(
          <line key={`u-p-${rowIdx}-${l}`} className={cls} x1={xl} y1={top} x2={xl} y2={mid} />,
        );
      }
    });

    const halfBottom = ROW_HEIGHT - MID_Y;
    row.lanesBelow.forEach((hash, l) => {
      if (hash === null) return;
      const xl = laneCenter(l);
      const cls = `wt-commit-visual-line ${colorClass(l)}`;
      const above = row.lanesAbove[l];
      const born = above === null || above === shortHash;
      if (born) {
        if (l === row.laneNode) {
          segments.push(
            <line
              key={`d-s-${rowIdx}-${l}`}
              className={cls}
              x1={xl}
              y1={mid}
              x2={xl}
              y2={bottom}
            />,
          );
        } else {
          const dx = xl - nodeX;
          segments.push(
            <path
              key={`d-c-${rowIdx}-${l}`}
              className={cls}
              d={`M ${nodeX} ${mid} C ${nodeX + dx * 0.45} ${mid}, ${xl} ${mid + halfBottom * 0.55}, ${xl} ${bottom}`}
            />,
          );
        }
      } else {
        segments.push(
          <line key={`d-p-${rowIdx}-${l}`} className={cls} x1={xl} y1={mid} x2={xl} y2={bottom} />,
        );
      }
    });

    nodes.push(
      <circle
        key={`n-${rowIdx}`}
        className={`wt-commit-visual-node ${colorClass(row.laneNode)}`}
        cx={nodeX}
        cy={mid}
        r={NODE_RADIUS}
      />,
    );
  });

  return (
    <svg
      className="wt-commit-canvas"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      {segments}
      {nodes}
    </svg>
  );
}
