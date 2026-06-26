import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBookkeepingTaxonomy } from "@/lib/query";

export function BulkCategorySelect({
  categoryCode,
  subcategoryCode,
  onCategoryChange,
  onSubcategoryChange,
}: {
  categoryCode: string;
  subcategoryCode: string;
  onCategoryChange: (value: string) => void;
  onSubcategoryChange: (value: string) => void;
}) {
  const taxonomy = useBookkeepingTaxonomy();
  const categories =
    taxonomy.data?.filter((node) => node.parentCode === null || node.parentCode === undefined) ??
    [];
  const subcategories = taxonomy.data?.filter((node) => node.parentCode === categoryCode) ?? [];

  return (
    <div className="bk-bulk-category">
      <Select value={categoryCode} onValueChange={onCategoryChange}>
        <SelectTrigger aria-label="일괄 분류">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {categories.map((node) => (
            <SelectItem key={node.code} value={node.code}>
              {node.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={subcategoryCode || "__none__"}
        onValueChange={(value) => onSubcategoryChange(value === "__none__" ? "" : value)}
      >
        <SelectTrigger aria-label="일괄 소분류">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">소분류 없음</SelectItem>
          {subcategories.map((node) => (
            <SelectItem key={node.code} value={node.code}>
              {node.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
