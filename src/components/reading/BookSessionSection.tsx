import { Pencil, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { ReadingSession } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useDeleteReadingSession,
  useLogReadingSession,
  useUpdateReadingSession,
} from "@/lib/query";

import { buildReadingSessionUpdate, type ReadingSessionDraft } from "./readingEditDrafts";

/**
 * 세션 기록 섹션 — 드래프트는 로컬 소유. 부모가 `key={book.id}`로 마운트하므로
 * 책 전환 시 자동 리셋된다(keyed 리마운트 시딩 — effect 동기화 0).
 */
export function BookSessionSection({
  bookId,
  today,
  sessions,
}: {
  bookId: string;
  today: string;
  sessions: ReadingSession[];
}) {
  const logSession = useLogReadingSession();
  const deleteSession = useDeleteReadingSession();
  const updateSession = useUpdateReadingSession();
  const [pageDraft, setPageDraft] = useState("");
  const [minutesDraft, setMinutesDraft] = useState("");
  const [note, setNote] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ReadingSessionDraft | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const endPage = pageDraft.trim() === "" ? null : Number(pageDraft);
    const minutes = minutesDraft.trim() === "" ? null : Number(minutesDraft);
    if (endPage == null && minutes == null && note.trim() === "") return;
    logSession.mutate(
      {
        bookId,
        date: today,
        endPage: endPage != null && Number.isInteger(endPage) && endPage >= 0 ? endPage : null,
        minutes: minutes != null && Number.isInteger(minutes) && minutes > 0 ? minutes : null,
        note: note.trim() === "" ? null : note.trim(),
      },
      {
        onSuccess: () => {
          setPageDraft("");
          setMinutesDraft("");
          setNote("");
        },
      },
    );
  };

  return (
    <section className="rd-detail-section" aria-label="오늘 기록">
      <h3 className="typo-label-lg">세션 기록</h3>
      <form className="rd-session-form" onSubmit={submit}>
        <Input
          type="number"
          min={0}
          placeholder="현재 페이지"
          value={pageDraft}
          onChange={(e) => setPageDraft(e.target.value)}
        />
        <Input
          type="number"
          min={1}
          placeholder="분"
          value={minutesDraft}
          onChange={(e) => setMinutesDraft(e.target.value)}
        />
        <Input placeholder="메모 (선택)" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button type="submit" size="sm" disabled={logSession.isPending}>
          기록
        </Button>
      </form>
      {sessions.length > 0 && (
        <ul className="rd-session-list">
          {sessions.map((s) => (
            <li key={s.id} className="rd-session-item typo-label-md">
              {editingId === s.id && editDraft != null ? (
                <form
                  className="rd-session-edit"
                  onSubmit={(event) => {
                    event.preventDefault();
                    updateSession.mutate(buildReadingSessionUpdate(s.id, editDraft), {
                      onSuccess: () => {
                        setEditingId(null);
                        setEditDraft(null);
                      },
                    });
                  }}
                >
                  <label className="rd-edit-field typo-label-sm">
                    날짜
                    <Input
                      type="date"
                      required
                      value={editDraft.date}
                      onChange={(event) =>
                        setEditDraft((current) =>
                          current == null ? current : { ...current, date: event.target.value },
                        )
                      }
                    />
                  </label>
                  <label className="rd-edit-field typo-label-sm">
                    종료 페이지
                    <Input
                      type="number"
                      min={0}
                      value={editDraft.endPage}
                      onChange={(event) =>
                        setEditDraft((current) =>
                          current == null ? current : { ...current, endPage: event.target.value },
                        )
                      }
                    />
                  </label>
                  <label className="rd-edit-field typo-label-sm">
                    독서 시간 (분)
                    <Input
                      type="number"
                      min={1}
                      value={editDraft.minutes}
                      onChange={(event) =>
                        setEditDraft((current) =>
                          current == null ? current : { ...current, minutes: event.target.value },
                        )
                      }
                    />
                  </label>
                  <label className="rd-edit-field typo-label-sm">
                    메모
                    <Input
                      value={editDraft.note}
                      onChange={(event) =>
                        setEditDraft((current) =>
                          current == null ? current : { ...current, note: event.target.value },
                        )
                      }
                    />
                  </label>
                  <div className="rd-edit-actions">
                    <Button type="submit" size="sm" disabled={updateSession.isPending}>
                      저장
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditingId(null);
                        setEditDraft(null);
                      }}
                    >
                      취소
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <span>{s.date}</span>
                  <span className="rd-card-dim">
                    {[
                      s.endPage != null ? `~${s.endPage}p` : null,
                      s.minutes != null ? `${s.minutes}분` : null,
                      s.note,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <button
                    type="button"
                    className="rd-icon-btn"
                    aria-label="세션 수정"
                    onClick={() => {
                      setEditingId(s.id);
                      setEditDraft({
                        date: s.date,
                        endPage: s.endPage?.toString() ?? "",
                        minutes: s.minutes?.toString() ?? "",
                        note: s.note ?? "",
                      });
                    }}
                  >
                    <Pencil size={13} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="rd-icon-btn"
                    aria-label="세션 삭제"
                    onClick={() => deleteSession.mutate(s.id)}
                  >
                    <Trash2 size={13} aria-hidden />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
