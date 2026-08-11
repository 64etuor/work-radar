import { describe, expect, it } from "vitest";

import type { Book, BookQuote, ReadingSession } from "@/bindings";

import {
  bookDetailsDraft,
  buildBookDetailsPatch,
  buildBookQuoteUpdate,
  buildReadingSessionUpdate,
} from "./readingEditDrafts";

const book: Book = {
  id: "book-1",
  title: "하드씽",
  subtitle: "경영의 난제",
  authors: ["벤 호로위츠"],
  publisher: "한국경제신문",
  publishedDate: "2024-01-02",
  isbn13: "9780000000000",
  isbn10: null,
  pageCount: 400,
  coverUrl: null,
  description: "설명",
  categories: ["경영", "에세이"],
  language: "ko",
  source: "manual",
  sourceRef: null,
  status: "reading",
  rating: null,
  review: null,
  startedOn: "2026-07-01",
  finishedOn: null,
  currentPage: 42,
  favorite: false,
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

describe("reading edit drafts", () => {
  it("book details seed every user-editable bibliographic and progress field", () => {
    expect(bookDetailsDraft(book)).toEqual({
      title: "하드씽",
      subtitle: "경영의 난제",
      authors: "벤 호로위츠",
      publisher: "한국경제신문",
      publishedDate: "2024-01-02",
      isbn13: "9780000000000",
      isbn10: "",
      pageCount: "400",
      coverUrl: "",
      description: "설명",
      categories: "경영, 에세이",
      language: "ko",
      currentPage: "42",
      startedOn: "2026-07-01",
      finishedOn: "",
      favorite: false,
    });
  });

  it("book details parse page counts, progress, and comma-separated lists into a typed patch", () => {
    const draft = bookDetailsDraft(book);
    expect(
      buildBookDetailsPatch(book.id, {
        ...draft,
        authors: "벤 호로위츠, 김철수",
        categories: "경영, 리더십",
        pageCount: "432",
        currentPage: "88",
        favorite: true,
      }),
    ).toMatchObject({
      id: "book-1",
      authors: ["벤 호로위츠", "김철수"],
      categories: ["경영", "리더십"],
      pageCount: 432,
      currentPage: 88,
      favorite: true,
    });
  });

  it("book details explicitly clear optional fields erased by the user", () => {
    const draft = bookDetailsDraft(book);
    expect(
      buildBookDetailsPatch(book.id, {
        ...draft,
        publisher: "",
        pageCount: "",
        description: "",
      }).clear,
    ).toEqual(["publisher", "isbn10", "page_count", "cover_url", "description", "finished_on"]);
  });

  it("quote edit keeps the row id while replacing excerpt metadata", () => {
    const quote: BookQuote = {
      id: "quote-1",
      bookId: "book-1",
      quote: "원문",
      page: 10,
      thought: "생각",
      favorite: false,
      createdAt: "2026-07-01T00:00:00Z",
    };
    expect(
      buildBookQuoteUpdate(quote.id, {
        quote: "수정문",
        page: "11",
        thought: "수정 생각",
        favorite: true,
      }),
    ).toEqual({
      id: "quote-1",
      quote: "수정문",
      page: 11,
      thought: "수정 생각",
      favorite: true,
    });
  });

  it("session edit replaces date, page, minutes, and note without changing identity", () => {
    const session: ReadingSession = {
      id: "session-1",
      bookId: "book-1",
      date: "2026-07-01",
      endPage: 42,
      minutes: 30,
      note: "메모",
      createdAt: "2026-07-01T00:00:00Z",
    };
    expect(
      buildReadingSessionUpdate(session.id, {
        date: "2026-07-02",
        endPage: "55",
        minutes: "45",
        note: "정정",
      }),
    ).toEqual({
      id: "session-1",
      date: "2026-07-02",
      endPage: 55,
      minutes: 45,
      note: "정정",
    });
  });
});
