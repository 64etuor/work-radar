import * as React from "react";

import { cn } from "./cn";

// shadcn/ui table 프리미티브(스타일 수준 — 상태 없음). 시맨틱 <table>로 칼럼 정합을
// 구조적으로 보장한다(그리드 템플릿 수동 동기화 대체). 시각은 DESIGN.md hairline 문법:
// 헤더 아래 1px rule + 행 사이 hairline, 행 hover는 surface만.

export function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="wr-table-wrap w-full overflow-x-auto">
      <table className={cn("wr-table w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead className={cn("wr-table-header", className)} {...props} />;
}

export function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody className={cn("wr-table-body", className)} {...props} />;
}

export function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr className={cn("wr-table-row", className)} {...props} />;
}

export function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      className={cn("wr-table-head text-muted-foreground text-left align-middle", className)}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return <td className={cn("wr-table-cell align-middle", className)} {...props} />;
}
