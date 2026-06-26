import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBookkeepingTaxonomy } from "@/lib/query";

import { CATEGORY_OPTIONS } from "../bookkeepingConstants";

export function CategorySelect({
  id,
  value,
  onValueChange,
}: {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
}) {
  const taxonomy = useBookkeepingTaxonomy();
  // Top-level taxonomy categories (code → Korean label). Falls back to the legacy codes until the
  // seeded taxonomy loads; the selected `value` always stays a stable code.
  const options =
    taxonomy.data
      ?.filter((node) => node.parentCode === null)
      .map((node) => ({ value: node.code, label: node.label })) ?? [];
  const fallback = CATEGORY_OPTIONS.map((code) => ({ value: code, label: code }));
  const merged = options.length > 0 ? options : fallback;
  // Ensure the current value is always selectable even if it isn't a current top-level code.
  const items = merged.some((o) => o.value === value)
    ? merged
    : [...merged, { value, label: value }];
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
