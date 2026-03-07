import { NextResponse } from "next/server";
import { createSimplePdf } from "../../../../../lib/server/simplePdf";
import { getSettlementBundle } from "../../../../../lib/server/settlementDocs";
import { formatMoney, getChargeAmount, getSettlementBalance, inferSettlementTotal } from "../../../../../lib/settlementShared";

export const runtime = "nodejs";

export async function GET(req: Request, context: { params: { settlementId: string } }) {
  try {
    const url = new URL(req.url);
    const communityId = String(url.searchParams.get("communityId") || "").trim();
    const settlementId = String(context.params.settlementId || "").trim();

    if (!communityId || !settlementId) {
      return new NextResponse("Missing communityId or settlementId", { status: 400 });
    }

    const { settlement, relatedPayments, flat, payer, community } = await getSettlementBundle(communityId, settlementId);
    const total = inferSettlementTotal(settlement);
    const paid = relatedPayments.reduce((sum, p) => sum + (p.amountCents != null ? Number(p.amountCents) / 100 : Number(p.amount || 0)), 0);
    const balance = getSettlementBalance(settlement, relatedPayments);

    const lines = [
      `Rozliczenie: ${settlement.period || settlementId}`,
      `Wspolnota: ${String((community as any)?.name || communityId)}`,
      `Lokal: ${settlement.flatId || flat?.flatLabel || payer?.flatLabel || "-"}`,
      `Lokator: ${settlement.residentName || [flat?.name, flat?.surname].filter(Boolean).join(" ") || [payer?.name, payer?.surname].filter(Boolean).join(" ") || "-"}`,
      `Termin platnosci: ${settlement.dueDate || "-"}`,
      `Numer konta: ${settlement.bankAccount || settlement.accountNumber || "-"}`,
      `Tytul przelewu: ${settlement.transferTitle || "-"}`,
      " ",
      "Pozycje:",
      ...((settlement.charges || settlement.chargesBreakdown || []).map((item, index) => `${index + 1}. ${item.label || item.category || "Pozycja"}: ${formatMoney(getChargeAmount(item))}`)),
      " ",
      `Suma oplat: ${formatMoney(total)}`,
      `Suma wplat: ${formatMoney(paid)}`,
      `Saldo: ${formatMoney(balance)}`,
    ];

    const pdf = createSimplePdf(lines);
    return new NextResponse(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="settlement-${settlementId}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error: any) {
    return new NextResponse(error?.message || "PDF error", { status: 500 });
  }
}
