import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBookkeepingTaxonomy } from "@/lib/query";

import { Field } from "../../settings/SettingsKit";
import { CATEGORY_OPTIONS } from "../bookkeepingConstants";
import { ensureSelectOption } from "./cardHelpers";

export function TaxonomyEditFields({
  prefix,
  categoryCode,
  subcategoryCode,
  onCategoryChange,
  onSubcategoryChange,
}: {
  prefix: string;
  categoryCode: string;
  subcategoryCode: string;
  onCategoryChange: (value: string) => void;
  onSubcategoryChange: (value: string) => void;
}) {
  const taxonomy = useBookkeepingTaxonomy();
  const topLevel =
    taxonomy.data
      ?.filter((node) => node.parentCode === null)
      .map((node) => ({ value: node.code, label: node.label })) ?? [];
  const subcategories =
    taxonomy.data
      ?.filter((node) => node.parentCode === categoryCode)
      .map((node) => ({ value: node.code, label: node.label })) ?? [];
  const topItems = ensureSelectOption(
    topLevel.length > 0 ? topLevel : CATEGORY_OPTIONS.map((code) => ({ value: code, label: code })),
    categoryCode,
  );
  const subItems = ensureSelectOption(subcategories, subcategoryCode);

  return (
    <div className="bk-form-grid">
      <Field label="카테고리" htmlFor={`${prefix}-category`}>
        <Select value={categoryCode} onValueChange={onCategoryChange}>
          <SelectTrigger id={`${prefix}-category`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {topItems.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="소분류" htmlFor={`${prefix}-subcategory`}>
        <Select
          value={subcategoryCode || "__none__"}
          onValueChange={(value) => onSubcategoryChange(value === "__none__" ? "" : value)}
        >
          <SelectTrigger id={`${prefix}-subcategory`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">없음</SelectItem>
            {subItems
              .filter((option) => option.value)
              .map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}
