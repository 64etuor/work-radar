import { Coins } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { Field } from "../../settings/SettingsKit";
import { FIELD_IDS } from "../bookkeepingConstants";

/** 드롭다운 후보 — 백엔드는 임의 ISO 4217 3자리를 받지만(clean_currency), 가져오기
 *  표면에서는 오타 방지를 위해 통용 통화만 노출한다. 목록 밖 저장값은 아래에서 동적 포함. */
const CURRENCY_OPTIONS: { code: string; label: string }[] = [
  { code: "KRW", label: "KRW — 대한민국 원" },
  { code: "USD", label: "USD — 미국 달러" },
  { code: "JPY", label: "JPY — 일본 엔" },
  { code: "EUR", label: "EUR — 유로" },
  { code: "CNY", label: "CNY — 중국 위안" },
  { code: "GBP", label: "GBP — 영국 파운드" },
  { code: "AUD", label: "AUD — 호주 달러" },
  { code: "CAD", label: "CAD — 캐나다 달러" },
];

/**
 * 앱 기본 통화 설정 카드(범용화). 새 거래/고정비/예산의 통화 미지정 시 이 값이 쓰인다.
 * 드롭다운 선택 즉시 저장한다(별도 저장 버튼 없음 — 선택 자체가 의도적 행위).
 */
export function DefaultCurrencyCard({
  current,
  pending,
  onSave,
}: {
  current: string;
  pending: boolean;
  onSave: (currency: string) => void;
}) {
  // 과거에 목록 밖 코드(예: CHF)를 저장했어도 현재 값이 항상 표시되도록 동적 포함.
  const options = CURRENCY_OPTIONS.some((option) => option.code === current)
    ? CURRENCY_OPTIONS
    : [{ code: current, label: current }, ...CURRENCY_OPTIONS];

  return (
    <Card className="bk-card">
      <CardHeader className="bk-card-head">
        <CardTitle className="bk-card-title">
          <Coins className="size-4" />
          기본 통화
        </CardTitle>
        <CardDescription className="bk-card-desc">
          통화를 지정하지 않은 새 거래·고정비·예산에 적용
        </CardDescription>
      </CardHeader>
      <CardContent className="bk-card-body">
        <Field htmlFor={FIELD_IDS.defaultCurrency} label="통화">
          <Select
            value={current}
            disabled={pending}
            onValueChange={(next) => {
              if (next !== current) onSave(next);
            }}
          >
            <SelectTrigger id={FIELD_IDS.defaultCurrency}>
              <SelectValue placeholder="통화 선택" />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.code} value={option.code}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </CardContent>
    </Card>
  );
}
