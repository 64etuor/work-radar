import { PackagePlus, Plus, Trash2, X } from "lucide-react";
import { type FormEvent, useState } from "react";

import type {
  GroceryOrder,
  GroceryOrderLine,
  GroceryOrderLineInput,
  PantryEventKind,
  PantryLocation,
  PantryLot,
} from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { DatePicker } from "@/components/ui/date-picker";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  localToday,
  useAddPantryLot,
  useAdjustPantryLot,
  useConsumePantry,
  useDietShoppingList,
  useExpiringPantry,
  useGroceryOrders,
  useMealPlans,
  usePantry,
  useReceiveOrderLine,
  useRecordGroceryOrder,
  useSetGroceryOrderStatus,
  useSetOrderLineFood,
  useWastePantryLot,
} from "@/lib/query";

import {
  expiryTone,
  fmtG,
  fmtKrw,
  LOCATION_LABEL,
  num,
  ORDER_STATUS_LABEL,
  parseOptionalInt,
  parseOptionalNumber,
  PLAN_STATUS_LABEL,
} from "./dietFormat";
import { FoodSelect } from "./FoodSelect";

const LOCATIONS: readonly PantryLocation[] = ["fridge", "freezer", "pantry", "other"];

function ExpiryBadge({ expiresOn, today }: { expiresOn: string | null; today: string }) {
  const tone = expiryTone(expiresOn, today);
  if (tone == null || expiresOn == null) return null;
  return (
    <Badge variant="outline" className={cn("diet-expiry", `tone-${tone}`)}>
      {tone === "expired" ? "지남" : ""} ~{expiresOn.slice(5)}
    </Badge>
  );
}

export function PantrySection() {
  const today = localToday();
  const { data: pantry } = usePantry();
  const { data: expiring } = useExpiringPantry(today, 7);
  const [addOpen, setAddOpen] = useState(false);
  const [consumeFor, setConsumeFor] = useState<{ foodId: string; foodName: string } | null>(null);
  const [adjustLot, setAdjustLot] = useState<PantryLot | null>(null);
  const [wasteLot, setWasteLot] = useState<PantryLot | null>(null);

  return (
    <section className="diet-section" aria-label="재고 관리">
      {expiring != null && expiring.length > 0 && (
        <div className="diet-expiring-strip" role="note" aria-label="유통기한 임박">
          <span className="typo-label-sm">유통기한 주의</span>
          {expiring.map((lot) => (
            <span key={lot.id} className="diet-expiring-chip typo-caption-sm">
              {lot.foodName} {fmtG(lot.remainingQtyG)}
              <ExpiryBadge expiresOn={lot.expiresOn} today={today} />
            </span>
          ))}
        </div>
      )}

      <div className="diet-toolbar">
        <h2 className="typo-body-strong">재고</h2>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <PackagePlus className="size-4" /> 입고
        </Button>
      </div>

      {pantry == null || pantry.length === 0 ? (
        <EmptyState className="diet-empty" title="재고 없음">
          입고 버튼으로 직접 추가하거나, 주문 라인 입고로 채운다.
        </EmptyState>
      ) : (
        <div className="diet-pantry-groups">
          {pantry.map((group) => (
            <div key={group.foodId} className="diet-pantry-group">
              <div className="diet-pantry-grouphead">
                <span className="typo-body-strong">{group.foodName}</span>
                <span className="typo-label-sm">{fmtG(group.totalRemainingG)}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConsumeFor({ foodId: group.foodId, foodName: group.foodName })}
                >
                  소비
                </Button>
              </div>
              <ul className="diet-lot-list">
                {group.lots.map((lot) => (
                  <li key={lot.id} className="diet-lot-row">
                    <Badge variant="outline">{LOCATION_LABEL[lot.location]}</Badge>
                    <span className="typo-caption-sm">입고 {lot.acquiredOn.slice(5)}</span>
                    <ExpiryBadge expiresOn={lot.expiresOn} today={today} />
                    <span className="diet-lot-qty typo-label-sm">
                      {fmtG(lot.remainingQtyG)}
                      <span className="typo-micro"> / {fmtG(lot.initialQtyG)}</span>
                    </span>
                    <span className="diet-lot-actions">
                      <Button variant="ghost" size="sm" onClick={() => setAdjustLot(lot)}>
                        보정
                      </Button>
                      <Button variant="destructiveGhost" size="sm" onClick={() => setWasteLot(lot)}>
                        폐기
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <ShoppingPanel />
      <OrdersPanel today={today} />

      <AddLotDialog open={addOpen} onOpenChange={setAddOpen} today={today} />
      <ConsumeDialog target={consumeFor} onOpenChange={(open) => !open && setConsumeFor(null)} />
      <AdjustDialog lot={adjustLot} onOpenChange={(open) => !open && setAdjustLot(null)} />
      <WasteDialog lot={wasteLot} onOpenChange={(open) => !open && setWasteLot(null)} />
    </section>
  );
}

// ── 장보기(파생 — 읽기 전용) ──────────────────────────────────────────

function ShoppingPanel() {
  const { data: plans } = useMealPlans();
  const candidates = (plans ?? []).filter((p) => p.status !== "archived");
  const defaultPlan = candidates.find((p) => p.status === "active") ?? candidates[0] ?? null;
  const [planId, setPlanId] = useState<string | null>(null);
  // 명시 선택한 계획이 이후 아카이브되면 후보에서 사라진다 — stale id 대신 기본으로 폴백.
  const selected = planId != null && candidates.some((p) => p.id === planId) ? planId : null;
  const effectivePlanId = selected ?? defaultPlan?.id ?? null;
  const { data: entries } = useDietShoppingList(effectivePlanId);

  return (
    <div className="diet-panel">
      <div className="diet-toolbar">
        <h2 className="typo-body-strong">장보기 (계획 필요량 − 재고 − 미입고)</h2>
        {candidates.length > 0 && (
          <Select value={effectivePlanId ?? undefined} onValueChange={setPlanId}>
            <SelectTrigger className="diet-select">
              <SelectValue placeholder="계획 선택" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.startDate.slice(5)}~{p.endDate.slice(5)} ({PLAN_STATUS_LABEL[p.status]})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {effectivePlanId == null ? (
        <EmptyState className="diet-empty">계획이 없다 — 계획 생성은 Hermes 몫.</EmptyState>
      ) : entries == null || entries.length === 0 ? (
        <EmptyState className="diet-empty">이 계획엔 남은 필요량이 없다.</EmptyState>
      ) : (
        <ul className="diet-shopping-list">
          <li className="diet-shopping-row diet-shopping-head typo-label-sm" aria-hidden>
            <span>식품</span>
            <span>필요</span>
            <span>재고</span>
            <span>미입고</span>
            <span>순필요</span>
          </li>
          {entries.map((e) => (
            <li key={e.foodId} className="diet-shopping-row typo-body-md">
              <span>{e.foodName}</span>
              <span>{fmtG(e.requiredG)}</span>
              <span>{fmtG(e.availableG)}</span>
              <span>{fmtG(e.pendingG)}</span>
              <span className={cn(num(e.netNeededG) > 0 && "diet-shopping-need")}>
                {fmtG(e.netNeededG)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── 주문 내역(기록 원장) + 라인 입고 ──────────────────────────────────

function OrdersPanel({ today }: { today: string }) {
  const { data: orders } = useGroceryOrders(20);
  const [recordOpen, setRecordOpen] = useState(false);
  const [receiveLine, setReceiveLine] = useState<GroceryOrderLine | null>(null);
  const setStatus = useSetGroceryOrderStatus();
  const setLineFood = useSetOrderLineFood();

  return (
    <div className="diet-panel">
      <div className="diet-toolbar">
        <h2 className="typo-body-strong">주문 내역</h2>
        <Button variant="outline" size="sm" onClick={() => setRecordOpen(true)}>
          <Plus className="size-4" /> 주문 기록
        </Button>
      </div>
      {orders == null || orders.length === 0 ? (
        <EmptyState className="diet-empty" title="주문 없음">
          기록 전용 원장 — 결제/체크아웃 기능이 아니다.
        </EmptyState>
      ) : (
        <div className="diet-order-list">
          {orders.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              onStatus={(status) => setStatus.mutate({ id: order.id, status })}
              onLinkFood={(lineId, foodId) => setLineFood.mutate({ lineId, foodId })}
              onReceive={setReceiveLine}
            />
          ))}
        </div>
      )}
      <RecordOrderDialog open={recordOpen} onOpenChange={setRecordOpen} today={today} />
      <ReceiveDialog
        line={receiveLine}
        today={today}
        onOpenChange={(open) => !open && setReceiveLine(null)}
      />
    </div>
  );
}

function OrderCard({
  order,
  onStatus,
  onLinkFood,
  onReceive,
}: {
  order: GroceryOrder;
  onStatus: (status: GroceryOrder["status"]) => void;
  onLinkFood: (lineId: string, foodId: string) => void;
  onReceive: (line: GroceryOrderLine) => void;
}) {
  return (
    <div className="diet-order-card">
      <div className="diet-order-head">
        <span className="typo-body-strong">{order.merchant}</span>
        <span className="typo-caption-sm">{order.orderedAt.slice(0, 10)}</span>
        {order.totalKrw != null && <span className="typo-label-sm">{fmtKrw(order.totalKrw)}</span>}
        <Select value={order.status} onValueChange={(v) => onStatus(v as GroceryOrder["status"])}>
          <SelectTrigger className="diet-select diet-select-compact">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(ORDER_STATUS_LABEL) as GroceryOrder["status"][]).map((s) => (
              <SelectItem key={s} value={s}>
                {ORDER_STATUS_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ul className="diet-order-lines">
        {order.lines.map((line) => (
          <li key={line.id} className="diet-order-line">
            <span className="diet-order-product typo-body-md">{line.productName}</span>
            <span className="typo-caption-sm">
              {line.totalG != null ? fmtG(line.totalG) : "중량 미상"}
              {line.lineTotalKrw != null && ` · ${fmtKrw(line.lineTotalKrw)}`}
            </span>
            {line.received ? (
              <Badge variant="outline" className="diet-received">
                입고됨
              </Badge>
            ) : line.foodId == null ? (
              <span className="diet-order-link">
                <FoodSelect
                  value={null}
                  placeholder="식품 연결"
                  onChange={(foodId) => onLinkFood(line.id, foodId)}
                />
              </span>
            ) : (
              <Button variant="outline" size="sm" onClick={() => onReceive(line)}>
                입고
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── 다이얼로그들 ──────────────────────────────────────────────────────

function AddLotDialog({
  open,
  onOpenChange,
  today,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  today: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <AddLotBody today={today} onDone={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function AddLotBody({ today, onDone }: { today: string; onDone: () => void }) {
  const addLot = useAddPantryLot();
  const [foodId, setFoodId] = useState<string | null>(null);
  const [location, setLocation] = useState<PantryLocation>("fridge");
  const [acquiredOn, setAcquiredOn] = useState(today);
  const [expiresOn, setExpiresOn] = useState<string | null>(null);
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (addLot.isPending || foodId == null) return;
    const qtyG = Number(qty);
    if (!Number.isFinite(qtyG) || qtyG <= 0) return;
    await addLot.mutateAsync({
      foodId,
      location,
      acquiredOn,
      expiresOn,
      initialQtyG: qtyG,
      note: note.trim() || null,
    });
    onDone();
  };

  return (
    <DialogContent className="diet-dialog" aria-describedby={undefined}>
      <DialogTitle>재고 입고</DialogTitle>
      <form className="diet-form" onSubmit={submit}>
        <label className="diet-field">
          <span className="typo-label-sm">식품</span>
          <FoodSelect value={foodId} onChange={setFoodId} />
        </label>
        <div className="diet-form-grid">
          <label className="diet-field">
            <span className="typo-label-sm">보관</span>
            <Select value={location} onValueChange={(v) => setLocation(v as PantryLocation)}>
              <SelectTrigger className="diet-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOCATIONS.map((loc) => (
                  <SelectItem key={loc} value={loc}>
                    {LOCATION_LABEL[loc]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">수량 (g)</span>
            <Input
              inputMode="numeric"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="1200"
              required
            />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">입고일</span>
            <DatePicker value={acquiredOn} onChange={(d) => d && setAcquiredOn(d)} />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">유통기한</span>
            <DatePicker value={expiresOn} onChange={setExpiresOn} clearable />
          </label>
        </div>
        <label className="diet-field">
          <span className="typo-label-sm">메모</span>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="diet-form-actions">
          <Button type="submit" disabled={addLot.isPending || foodId == null}>
            입고
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

function ConsumeDialog({
  target,
  onOpenChange,
}: {
  target: { foodId: string; foodName: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={target != null} onOpenChange={onOpenChange}>
      {target != null && (
        <ConsumeBody key={target.foodId} target={target} onDone={() => onOpenChange(false)} />
      )}
    </Dialog>
  );
}

function ConsumeBody({
  target,
  onDone,
}: {
  target: { foodId: string; foodName: string };
  onDone: () => void;
}) {
  const consume = useConsumePantry();
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [shortfall, setShortfall] = useState<number | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (consume.isPending) return;
    const qtyG = Number(qty);
    if (!Number.isFinite(qtyG) || qtyG <= 0) return;
    const result = await consume.mutateAsync({
      foodId: target.foodId,
      qtyG,
      reason: reason.trim() || null,
    });
    const missing = num(result.shortfallG);
    if (missing > 0) {
      // 부족분은 커밋됐다(있는 만큼 FEFO 차감) — 닫지 말고 사실을 보여준다.
      setShortfall(missing);
    } else {
      onDone();
    }
  };

  return (
    <DialogContent className="diet-dialog" aria-describedby={undefined}>
      <DialogTitle>소비 — {target.foodName}</DialogTitle>
      <form className="diet-form" onSubmit={submit}>
        <div className="diet-form-grid">
          <label className="diet-field">
            <span className="typo-label-sm">수량 (g)</span>
            <Input
              inputMode="numeric"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="300"
              required
              autoFocus
            />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">사유</span>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="저녁 조리"
            />
          </label>
        </div>
        <p className="typo-caption-sm">유통기한 빠른 로트부터 차감된다(FEFO).</p>
        {shortfall != null && (
          <p className="diet-shortfall typo-body-md">
            재고보다 {fmtG(shortfall)} 부족 — 있는 만큼만 차감했다.
          </p>
        )}
        <div className="diet-form-actions">
          {shortfall != null ? (
            <Button type="button" onClick={onDone}>
              확인
            </Button>
          ) : (
            <Button type="submit" disabled={consume.isPending}>
              차감
            </Button>
          )}
        </div>
      </form>
    </DialogContent>
  );
}

function AdjustDialog({
  lot,
  onOpenChange,
}: {
  lot: PantryLot | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={lot != null} onOpenChange={onOpenChange}>
      {lot != null && <AdjustBody key={lot.id} lot={lot} onDone={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function AdjustBody({ lot, onDone }: { lot: PantryLot; onDone: () => void }) {
  const adjust = useAdjustPantryLot();
  const [remaining, setRemaining] = useState(String(Math.round(num(lot.remainingQtyG))));
  const [reason, setReason] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (adjust.isPending) return;
    const value = Number(remaining);
    if (!Number.isFinite(value) || value < 0) return;
    await adjust.mutateAsync({
      lotId: lot.id,
      newRemainingG: value,
      reason: reason.trim() || null,
    });
    onDone();
  };

  return (
    <DialogContent className="diet-dialog" aria-describedby={undefined}>
      <DialogTitle>실사 보정 — {lot.foodName}</DialogTitle>
      <form className="diet-form" onSubmit={submit}>
        <div className="diet-form-grid">
          <label className="diet-field">
            <span className="typo-label-sm">실측 잔량 (g)</span>
            <Input
              inputMode="numeric"
              value={remaining}
              onChange={(e) => setRemaining(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">사유</span>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="실사" />
          </label>
        </div>
        <p className="typo-caption-sm">
          현재 {fmtG(lot.remainingQtyG)} → 차이는 adjusted 이벤트로 남는다.
        </p>
        <div className="diet-form-actions">
          <Button type="submit" disabled={adjust.isPending}>
            보정
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

function WasteDialog({
  lot,
  onOpenChange,
}: {
  lot: PantryLot | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={lot != null} onOpenChange={onOpenChange}>
      {lot != null && <WasteBody key={lot.id} lot={lot} onDone={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function WasteBody({ lot, onDone }: { lot: PantryLot; onDone: () => void }) {
  const waste = useWastePantryLot();
  const [qty, setQty] = useState("");
  const [kind, setKind] = useState<PantryEventKind>("wasted");
  const [reason, setReason] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (waste.isPending) return;
    const qtyG = qty.trim() === "" ? null : Number(qty);
    if (qtyG != null && (!Number.isFinite(qtyG) || qtyG <= 0)) return;
    await waste.mutateAsync({
      lotId: lot.id,
      qtyG,
      kind,
      reason: reason.trim() || null,
    });
    onDone();
  };

  return (
    <DialogContent className="diet-dialog" aria-describedby={undefined}>
      <DialogTitle>
        <Trash2 className="size-4" /> 폐기 — {lot.foodName}
      </DialogTitle>
      <form className="diet-form" onSubmit={submit}>
        <div className="diet-form-grid">
          <label className="diet-field">
            <span className="typo-label-sm">수량 (g, 비우면 전량 {fmtG(lot.remainingQtyG)})</span>
            <Input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">종류</span>
            <Select value={kind} onValueChange={(v) => setKind(v as PantryEventKind)}>
              <SelectTrigger className="diet-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="wasted">폐기</SelectItem>
                <SelectItem value="expired">유통기한 만료</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>
        <label className="diet-field">
          <span className="typo-label-sm">사유</span>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="diet-form-actions">
          <Button type="submit" variant="destructive" disabled={waste.isPending}>
            폐기 기록
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

type DraftLine = {
  productName: string;
  foodId: string | null;
  totalG: string;
  lineTotalKrw: string;
};

const EMPTY_LINE: DraftLine = { productName: "", foodId: null, totalG: "", lineTotalKrw: "" };

function RecordOrderDialog({
  open,
  onOpenChange,
  today,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  today: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <RecordOrderBody today={today} onDone={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function RecordOrderBody({ today, onDone }: { today: string; onDone: () => void }) {
  const record = useRecordGroceryOrder();
  const [merchant, setMerchant] = useState("");
  const [orderedOn, setOrderedOn] = useState(today);
  const [totalKrw, setTotalKrw] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ ...EMPTY_LINE }]);

  const patchLine = (index: number, patch: Partial<DraftLine>) => {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (record.isPending) return;
    const cleanLines: GroceryOrderLineInput[] = lines
      .filter((l) => l.productName.trim().length > 0)
      .map((l) => ({
        productName: l.productName.trim(),
        foodId: l.foodId,
        quantity: 1,
        totalG: parseOptionalNumber(l.totalG),
        unitPriceKrw: null,
        lineTotalKrw: parseOptionalInt(l.lineTotalKrw),
        note: null,
      }));
    if (merchant.trim().length === 0 || cleanLines.length === 0) return;
    await record.mutateAsync({
      merchant: merchant.trim(),
      orderedAt: orderedOn,
      externalOrderNo: null,
      totalKrw: parseOptionalInt(totalKrw),
      shippingKrw: null,
      note: null,
      lines: cleanLines,
    });
    onDone();
  };

  return (
    <DialogContent className="diet-dialog diet-dialog-wide" aria-describedby={undefined}>
      <DialogTitle>주문 기록 (원장 — 결제 아님)</DialogTitle>
      <form className="diet-form" onSubmit={submit}>
        <div className="diet-form-grid">
          <label className="diet-field">
            <span className="typo-label-sm">판매처</span>
            <Input
              value={merchant}
              onChange={(e) => setMerchant(e.target.value)}
              placeholder="coupang"
              required
            />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">주문일</span>
            <DatePicker value={orderedOn} onChange={(d) => d && setOrderedOn(d)} />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">총액 (원)</span>
            <Input
              inputMode="numeric"
              value={totalKrw}
              onChange={(e) => setTotalKrw(e.target.value)}
            />
          </label>
        </div>
        <div className="diet-draftlines">
          {lines.map((line, i) => (
            // 재정렬 없는 append/patch 드래프트 — index key 안전.
            <div key={i} className="diet-draftline">
              <Input
                value={line.productName}
                onChange={(e) => patchLine(i, { productName: e.target.value })}
                placeholder="상품명"
              />
              <FoodSelect
                value={line.foodId}
                placeholder="식품 연결(선택)"
                onChange={(foodId) => patchLine(i, { foodId })}
              />
              <Input
                inputMode="numeric"
                value={line.totalG}
                onChange={(e) => patchLine(i, { totalG: e.target.value })}
                placeholder="중량 g"
              />
              <Input
                inputMode="numeric"
                value={line.lineTotalKrw}
                onChange={(e) => patchLine(i, { lineTotalKrw: e.target.value })}
                placeholder="금액 원"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="라인 삭제"
                disabled={lines.length === 1}
                onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
              >
                <X className="size-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])}
          >
            <Plus className="size-4" /> 라인 추가
          </Button>
        </div>
        <div className="diet-form-actions">
          <Button type="submit" disabled={record.isPending}>
            기록
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

function ReceiveDialog({
  line,
  today,
  onOpenChange,
}: {
  line: GroceryOrderLine | null;
  today: string;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={line != null} onOpenChange={onOpenChange}>
      {line != null && (
        <ReceiveBody key={line.id} line={line} today={today} onDone={() => onOpenChange(false)} />
      )}
    </Dialog>
  );
}

function ReceiveBody({
  line,
  today,
  onDone,
}: {
  line: GroceryOrderLine;
  today: string;
  onDone: () => void;
}) {
  const receive = useReceiveOrderLine();
  const [location, setLocation] = useState<PantryLocation>("fridge");
  const [acquiredOn, setAcquiredOn] = useState(today);
  const [expiresOn, setExpiresOn] = useState<string | null>(null);
  const [override, setOverride] = useState("");
  const needsWeight = line.totalG == null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (receive.isPending) return;
    const overrideG = parseOptionalNumber(override);
    if (needsWeight && overrideG == null) return;
    await receive.mutateAsync({
      lineId: line.id,
      location,
      acquiredOn,
      expiresOn,
      totalGOverride: overrideG,
    });
    onDone();
  };

  return (
    <DialogContent className="diet-dialog" aria-describedby={undefined}>
      <DialogTitle>입고 — {line.productName}</DialogTitle>
      <form className="diet-form" onSubmit={submit}>
        <div className="diet-form-grid">
          <label className="diet-field">
            <span className="typo-label-sm">보관</span>
            <Select value={location} onValueChange={(v) => setLocation(v as PantryLocation)}>
              <SelectTrigger className="diet-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOCATIONS.map((loc) => (
                  <SelectItem key={loc} value={loc}>
                    {LOCATION_LABEL[loc]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">입고일</span>
            <DatePicker value={acquiredOn} onChange={(d) => d && setAcquiredOn(d)} />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">유통기한</span>
            <DatePicker value={expiresOn} onChange={setExpiresOn} clearable />
          </label>
          <label className="diet-field">
            <span className="typo-label-sm">
              중량 override (g{needsWeight ? " — 라인에 중량 없음, 필수" : ""})
            </span>
            <Input
              inputMode="numeric"
              value={override}
              onChange={(e) => setOverride(e.target.value)}
              placeholder={line.totalG != null ? String(Math.round(num(line.totalG))) : "1200"}
              required={needsWeight}
            />
          </label>
        </div>
        <p className="typo-caption-sm">입고는 라인당 1회 — 로트 생성과 함께 잠긴다.</p>
        <div className="diet-form-actions">
          <Button type="submit" disabled={receive.isPending}>
            입고
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
