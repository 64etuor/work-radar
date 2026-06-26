import type { Project } from "@/bindings";
import { PeriodNavigator } from "@/components/PeriodNavigator";
import { formatMonthValue } from "@/components/periodNavigatorUtils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { Field } from "../../settings/SettingsKit";
import { ALL_PROJECTS, FIELD_IDS } from "../bookkeepingConstants";
import { currentMonth } from "../bookkeepingMonth";

export function BookkeepingScopeControls({
  month,
  projects,
  selectedProjectId,
  onProjectChange,
  onPreviousMonth,
  onNextMonth,
  onResetMonth,
}: {
  month: string;
  projects: Project[];
  selectedProjectId: string;
  onProjectChange: (projectId: string) => void;
  onPreviousMonth: () => void;
  onNextMonth: () => void;
  onResetMonth: () => void;
}) {
  return (
    <div className="bk-scope-controls">
      <PeriodNavigator
        label="기준 연월"
        valueLabel={formatMonthValue(month)}
        previousLabel="이전 달"
        nextLabel="다음 달"
        resetLabel="이번 달로 이동"
        resetDisabled={month === currentMonth()}
        onPrevious={onPreviousMonth}
        onNext={onNextMonth}
        onReset={onResetMonth}
      />
      <Field label="프로젝트" htmlFor={FIELD_IDS.projectScope}>
        <Select value={selectedProjectId} onValueChange={onProjectChange}>
          <SelectTrigger id={FIELD_IDS.projectScope}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PROJECTS}>전체 프로젝트</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}
