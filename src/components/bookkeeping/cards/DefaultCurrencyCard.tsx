import { Check, Coins } from "lucide-react";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { Field } from "../../settings/SettingsKit";
import { FIELD_IDS } from "../bookkeepingConstants";

/**
 * 앱 기본 통화 설정 카드(범용화). 새 거래/고정비/예산의 통화 미지정 시 이 값이 쓰인다.
 * draft=null이면 서버 값 표시(MoneyManagerImportCard의 watch-dir draft 패턴과 동일).
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
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? current;
  const dirty = value.trim().toUpperCase() !== current;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!dirty) return;
    onSave(value.trim().toUpperCase());
    setDraft(null);
  };

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
        <form className="bk-form" onSubmit={submit}>
          <Field htmlFor={FIELD_IDS.defaultCurrency} label="ISO 4217 코드">
            <Input
              id={FIELD_IDS.defaultCurrency}
              value={value}
              maxLength={3}
              placeholder="KRW"
              onChange={(event) => setDraft(event.target.value.toUpperCase())}
            />
          </Field>
          <Button type="submit" disabled={pending || !dirty || value.trim().length !== 3}>
            <Check className="size-4" />
            저장
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
