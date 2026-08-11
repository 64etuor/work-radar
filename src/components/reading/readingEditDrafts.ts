import type {
  Book,
  BookClearableField,
  UpdateBookInput,
  UpdateBookQuoteInput,
  UpdateReadingSessionInput,
} from "@/bindings";

import { emptyBookPatch } from "./readingFormat";

export interface BookDetailsDraft {
  title: string;
  subtitle: string;
  authors: string;
  publisher: string;
  publishedDate: string;
  isbn13: string;
  isbn10: string;
  pageCount: string;
  coverUrl: string;
  description: string;
  categories: string;
  language: string;
  currentPage: string;
  startedOn: string;
  finishedOn: string;
  favorite: boolean;
}

export interface BookQuoteDraft {
  quote: string;
  page: string;
  thought: string;
  favorite: boolean;
}

export interface ReadingSessionDraft {
  date: string;
  endPage: string;
  minutes: string;
  note: string;
}

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Number(trimmed) : null;
}

function stringList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function bookDetailsDraft(book: Book): BookDetailsDraft {
  return {
    title: book.title,
    subtitle: book.subtitle ?? "",
    authors: book.authors.join(", "),
    publisher: book.publisher ?? "",
    publishedDate: book.publishedDate ?? "",
    isbn13: book.isbn13 ?? "",
    isbn10: book.isbn10 ?? "",
    pageCount: book.pageCount?.toString() ?? "",
    coverUrl: book.coverUrl ?? "",
    description: book.description ?? "",
    categories: book.categories.join(", "),
    language: book.language ?? "",
    currentPage: book.currentPage.toString(),
    startedOn: book.startedOn ?? "",
    finishedOn: book.finishedOn ?? "",
    favorite: book.favorite,
  };
}

export function buildBookDetailsPatch(id: string, draft: BookDetailsDraft): UpdateBookInput {
  const clear: BookClearableField[] = [];
  if (draft.subtitle.trim().length === 0) clear.push("subtitle");
  if (draft.publisher.trim().length === 0) clear.push("publisher");
  if (draft.publishedDate.trim().length === 0) clear.push("published_date");
  if (draft.isbn13.trim().length === 0) clear.push("isbn13");
  if (draft.isbn10.trim().length === 0) clear.push("isbn10");
  if (draft.pageCount.trim().length === 0) clear.push("page_count");
  if (draft.coverUrl.trim().length === 0) clear.push("cover_url");
  if (draft.description.trim().length === 0) clear.push("description");
  if (draft.language.trim().length === 0) clear.push("language");
  if (draft.startedOn.trim().length === 0) clear.push("started_on");
  if (draft.finishedOn.trim().length === 0) clear.push("finished_on");

  return {
    ...emptyBookPatch(id),
    title: draft.title.trim(),
    subtitle: optionalText(draft.subtitle),
    authors: stringList(draft.authors),
    publisher: optionalText(draft.publisher),
    publishedDate: optionalText(draft.publishedDate),
    isbn13: optionalText(draft.isbn13),
    isbn10: optionalText(draft.isbn10),
    pageCount: optionalNumber(draft.pageCount),
    coverUrl: optionalText(draft.coverUrl),
    description: optionalText(draft.description),
    categories: stringList(draft.categories),
    language: optionalText(draft.language),
    currentPage: optionalNumber(draft.currentPage),
    favorite: draft.favorite,
    startedOn: optionalText(draft.startedOn),
    finishedOn: optionalText(draft.finishedOn),
    clear,
  };
}

export function buildBookQuoteUpdate(id: string, draft: BookQuoteDraft): UpdateBookQuoteInput {
  return {
    id,
    quote: draft.quote.trim(),
    page: optionalNumber(draft.page),
    thought: optionalText(draft.thought),
    favorite: draft.favorite,
  };
}

export function buildReadingSessionUpdate(
  id: string,
  draft: ReadingSessionDraft,
): UpdateReadingSessionInput {
  return {
    id,
    date: draft.date,
    endPage: optionalNumber(draft.endPage),
    minutes: optionalNumber(draft.minutes),
    note: optionalText(draft.note),
  };
}
