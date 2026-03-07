import { NextResponse } from "next/server";
import sgMail from "@sendgrid/mail";
import { getSettlementBundle } from "../../../../../lib/server/settlementDocs";
import { createSimplePdf } from "../../../../../lib/server/simplePdf";
import { formatMoney, getChargeAmount, getSettlementBalance, inferSettlementTotal } from "../../../../../lib/settlementShared";

export const runtime = "nodejs";

function periodLabel(period?: string) {
  return String(period || "Rozliczenie");
}

export async function POST(req: Request, context: { params: { settlementId: string } }) {
  try {
    const body = await req.json().catch(() => ({}));
    const communityId = String(body.communityId || "").trim();
    const settlementId = String(context.params.settlementId || "").trim();

    if (!communityId || !settlementId) {
      return NextResponse.json({ error: "Missing communityId or settlementId" }, { status: 400 });
    }

    const apiKey = process.env.SENDGRID_API_KEY;
    const from = process.env.SENDGRID_FROM_EMAIL;
    const euResidency = String(process.env.SENDGRID_EU_DATA_RESIDENCY || "false").toLowerCase() === "true";
    if (!apiKey || !from) {
      return NextResponse.json({ error: "Missing SendGrid env" }, { status: 500 });
    }

    sgMail.setApiKey(apiKey);
    if (euResidency && typeof (sgMail as any).setDataResidency === "function") {
      (sgMail as any).setDataResidency("eu");
    }

    const { settlement, relatedPayments, flat, payer, community, email } = await getSettlementBundle(communityId, settlementId);
    if (!email) {
      return NextResponse.json({ error: "No recipient email on settlement / flat / payer" }, { status: 400 });
    }

    const total = inferSettlementTotal(settlement);
    const paid = relatedPayments.reduce((sum, p) => sum + (p.amountCents != null ? Number(p.amountCents) / 100 : Number(p.amount || 0)), 0);
    const balance = getSettlementBalance(settlement, relatedPayments);
    const charges = settlement.charges || settlement.chargesBreakdown || [];

    const pdfLines = [
      `Rozliczenie: ${settlement.period || settlementId}`,
      `Wspolnota: ${String((community as any)?.name || communityId)}`,
      `Lokal: ${settlement.flatId || flat?.flatLabel || payer?.flatLabel || "-"}`,
      `Lokator: ${settlement.residentName || [flat?.name, flat?.surname].filter(Boolean).join(" ") || [payer?.name, payer?.surname].filter(Boolean).join(" ") || "-"}`,
      `Termin platnosci: ${settlement.dueDate || "-"}`,
      `Numer konta: ${settlement.bankAccount || settlement.accountNumber || "-"}`,
      `Tytul przelewu: ${settlement.transferTitle || "-"}`,
      ...charges.map((item, index) => `${index + 1}. ${item.label || item.category || "Pozycja"}: ${formatMoney(getChargeAmount(item))}`),
      `Suma oplat: ${formatMoney(total)}`,
      `Suma wplat: ${formatMoney(paid)}`,
      `Saldo: ${formatMoney(balance)}`,
    ];

    const pdf = createSimplePdf(pdfLines);
    const baseUrl = process.env.NEXT_PUBLIC_WEBPANEL_BASE_URL || new URL(req.url).origin;
    const pdfUrl = `${baseUrl}/api/settlements/${encodeURIComponent(settlementId)}/pdf?communityId=${encodeURIComponent(communityId)}`;

    const chargeHtml = charges.length
      ? `<ul>${charges.map((item) => `<li>${item.label || item.category || "Pozycja"}: ${formatMoney(getChargeAmount(item))}</li>`).join("")}</ul>`
      : `<p>Brak pozycji rozliczenia.</p>`;
    const paymentsHtml = relatedPayments.length
      ? `<ul>${relatedPayments.slice(0, 10).map((item) => `<li>${item.date || item.bookingDate || ""} — ${item.title || item.source || "Wpłata"} — ${formatMoney(item.amountCents != null ? Number(item.amountCents) / 100 : item.amount)}</li>`).join("")}</ul>`
      : `<p>Brak wpłat przypiętych do tego okresu.</p>`;

    await sgMail.send({
      to: email,
      from,
      subject: `e-Lokator — rozliczenie ${periodLabel(settlement.period)}`,
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
          <h2>Rozliczenie ${periodLabel(settlement.period)}</h2>
          <p><strong>Wspólnota:</strong> ${String((community as any)?.name || communityId)}</p>
          <p><strong>Lokal:</strong> ${settlement.flatId || flat?.flatLabel || payer?.flatLabel || "-"}<br/>
          <strong>Lokator:</strong> ${settlement.residentName || [flat?.name, flat?.surname].filter(Boolean).join(" ") || [payer?.name, payer?.surname].filter(Boolean).join(" ") || "-"}<br/>
          <strong>Termin płatności:</strong> ${settlement.dueDate || "-"}</p>
          <h3>Opłaty</h3>
          ${chargeHtml}
          <h3>Wpłaty</h3>
          ${paymentsHtml}
          <p><strong>Suma opłat:</strong> ${formatMoney(total)}<br/>
          <strong>Suma wpłat:</strong> ${formatMoney(paid)}<br/>
          <strong>Saldo:</strong> ${formatMoney(balance)}</p>
          <h3>Dane do przelewu</h3>
          <p><strong>Numer konta:</strong> ${settlement.bankAccount || settlement.accountNumber || "-"}<br/>
          <strong>Tytuł przelewu:</strong> ${settlement.transferTitle || "-"}</p>
          <p>Załącznik zawiera PDF rozliczenia. Podgląd online: <a href="${pdfUrl}">${pdfUrl}</a></p>
        </div>
      `,
      attachments: [
        {
          filename: `rozliczenie-${settlement.period || settlementId}.pdf`,
          type: "application/pdf",
          content: pdf.toString("base64"),
          disposition: "attachment",
        },
      ],
    });

    return NextResponse.json({ ok: true, email, pdfUrl });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Email error" }, { status: 500 });
  }
}
