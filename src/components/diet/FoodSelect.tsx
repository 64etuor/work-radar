import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFoods } from "@/lib/query";

/** 식품 선택 셀렉트 — 라이브러리의 비보관 식품 전체(개인 규모라 검색 없이 나열). */
export function FoodSelect({
  value,
  onChange,
  placeholder = "식품 선택",
}: {
  value: string | null;
  onChange: (foodId: string) => void;
  placeholder?: string;
}) {
  const { data: foods } = useFoods("", false);
  return (
    <Select value={value ?? undefined} onValueChange={onChange}>
      <SelectTrigger className="diet-select">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {(foods ?? []).map((f) => (
          <SelectItem key={f.id} value={f.id}>
            {f.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
