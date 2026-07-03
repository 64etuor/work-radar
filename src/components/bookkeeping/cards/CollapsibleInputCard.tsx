import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function CollapsibleInputCard({
  title,
  description,
  icon,
  open,
  contentId,
  children,
  onOpenChange,
}: {
  title: string;
  description?: string;
  icon: ReactNode;
  open: boolean;
  contentId: string;
  children: ReactNode;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Card className="bk-card bk-collapsible-card" data-state={open ? "open" : "closed"}>
      <CardHeader className="bk-card-header-row bk-collapsible-header">
        <div className="bk-collapsible-heading">
          <CardTitle className="bk-card-title">
            {icon}
            {title}
          </CardTitle>
          {description ? (
            <CardDescription className="bk-card-desc">{description}</CardDescription>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="bk-collapse-trigger"
          aria-controls={contentId}
          aria-expanded={open}
          aria-label={`${title} ${open ? "접기" : "펼치기"}`}
          onClick={() => onOpenChange(!open)}
        >
          <ChevronDown className="bk-collapse-chevron size-4" aria-hidden="true" />
        </Button>
      </CardHeader>
      <div
        id={contentId}
        className="bk-collapsible-region"
        data-state={open ? "open" : "closed"}
        aria-hidden={!open}
      >
        <div className="bk-collapsible-inner">{children}</div>
      </div>
    </Card>
  );
}
