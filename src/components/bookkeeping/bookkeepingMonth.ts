import { localToday } from "@/lib/query";

export function currentMonth() {
  return localToday().slice(0, 7);
}

export function stepMonthBy(month: string, offset: number) {
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthNumber = Number(monthText);
  if (!Number.isFinite(year) || !Number.isFinite(monthNumber)) return month;
  const next = new Date(year, monthNumber - 1 + offset, 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
}

export function monthRange(month: string): { fromDate: string; toDate: string } {
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthNumber = Number(monthText);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  return { fromDate: `${month}-01`, toDate: `${month}-${String(lastDay).padStart(2, "0")}` };
}
