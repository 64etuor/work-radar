import type { BookkeepingPaymentMethodKind } from "@/bindings";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { Field } from "../../settings/SettingsKit";
import { PAYMENT_METHOD_OPTIONS } from "../bookkeepingConstants";

export function PaymentFields({
  kindId,
  labelId,
  last4Id,
  kind,
  label,
  last4,
  onKindChange,
  onLabelChange,
  onLast4Change,
}: {
  kindId: string;
  labelId: string;
  last4Id: string;
  kind: BookkeepingPaymentMethodKind;
  label: string;
  last4: string;
  onKindChange: (value: BookkeepingPaymentMethodKind) => void;
  onLabelChange: (value: string) => void;
  onLast4Change: (value: string) => void;
}) {
  return (
    <div className="bk-payment-fields">
      <Field label="결제수단" htmlFor={kindId}>
        <Select
          value={kind}
          onValueChange={(value) => onKindChange(value as BookkeepingPaymentMethodKind)}
        >
          <SelectTrigger id={kindId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAYMENT_METHOD_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="표시명" htmlFor={labelId}>
        <Input id={labelId} value={label} onChange={(e) => onLabelChange(e.target.value)} />
      </Field>
      <Field label="끝자리" htmlFor={last4Id}>
        <Input
          id={last4Id}
          value={last4}
          onChange={(e) => onLast4Change(e.target.value)}
          inputMode="numeric"
        />
      </Field>
    </div>
  );
}
