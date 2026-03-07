export type ChargeItem = {
  label?: string;
  amount?: number;
  amountCents?: number;
  category?: string;
};

export type SettlementRecord = {
  id: string;
  flatId?: string;
  flatLabel?: string;
  residentName?: string;
  period?: string;
  dueDate?: string;
  bankAccount?: string;
  accountNumber?: string;
  transferTitle?: string;
  isPublished?: boolean;
  email?: string;
  charges?: ChargeItem[];
  chargesBreakdown?: ChargeItem[];
  chargesCents?: number;
  paymentsCents?: number;
  balanceCents?: number;
  totalCents?: number;
  total?: number;
};

export type PaymentRecord = {
  id: string;
  date?: string;
  bookingDate?: string;
  title?: string;
  source?: string;
  amount?: number;
  amountCents?: number;
  matched?: boolean;
  matchedBy?: string;
  status?: string;
  settlementId?: string;
  flatId?: string;
  period?: string;
  transferTitle?: string;
  isPublished?: boolean;
  createdAtMs?: number;
};

export function getChargeAmount(item: ChargeItem) {
  if (item.amountCents != null) return Number(item.amountCents) / 100;
  return Number(item.amount || 0);
}

export function getSettlementCharges(settlement: SettlementRecord | null | undefined): ChargeItem[] {
  const list = settlement?.charges || settlement?.chargesBreakdown || [];
  return Array.isArray(list) ? list : [];
}

export function formatMoney(value: number | string | null | undefined) {
  const n = Number(value || 0);
  return `${n.toFixed(2)} zł`;
}

export function inferSettlementTotal(settlement: SettlementRecord | null | undefined) {
  if (!settlement) return 0;
  if (settlement.totalCents != null) return Number(settlement.totalCents) / 100;
  if (settlement.total != null) return Number(settlement.total);
  if (settlement.balanceCents != null) return Number(settlement.balanceCents) / 100;
  return getSettlementCharges(settlement).reduce((sum, item) => sum + getChargeAmount(item), 0);
}

export function inferRelatedPayments(payments: PaymentRecord[], settlement: SettlementRecord | null | undefined) {
  if (!settlement) return [];
  const transferTitle = String(settlement.transferTitle || "").toLowerCase();
  const flatId = String(settlement.flatId || "").toLowerCase();
  const period = String(settlement.period || "").toLowerCase();
  const settlementId = String(settlement.id || "");

  return payments.filter((p) => {
    const title = `${p.title || ""} ${p.source || ""} ${p.transferTitle || ""}`.toLowerCase();
    return p.settlementId === settlementId
      || (!!flatId && String(p.flatId || "").toLowerCase() === flatId)
      || (!!transferTitle && title.includes(transferTitle))
      || (!!period && !!flatId && String(p.period || "").toLowerCase() === period && title.includes(flatId));
  });
}

export function sumPayments(payments: PaymentRecord[]) {
  return payments.reduce((sum, p) => sum + (p.amountCents != null ? Number(p.amountCents) / 100 : Number(p.amount || 0)), 0);
}

export function getSettlementBalance(settlement: SettlementRecord | null | undefined, payments: PaymentRecord[]) {
  if (!settlement) return 0;
  if (settlement.balanceCents != null) return Number(settlement.balanceCents) / 100;
  const charges = settlement.chargesCents != null ? Number(settlement.chargesCents) / 100 : inferSettlementTotal(settlement);
  const paid = settlement.paymentsCents != null ? Number(settlement.paymentsCents) / 100 : sumPayments(payments);
  return charges - paid;
}
