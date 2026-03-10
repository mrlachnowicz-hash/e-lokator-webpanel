import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/server/firebaseAdmin";
import { suggestPaymentMatch } from "@/lib/server/ai/payment";
import { ensurePaymentRef, extractPaymentRef, normalizePaymentRef } from "@/lib/server/paymentRefs";

export const runtime = "nodejs";

function periodToDueDate(period: string) {
  const base = new Date(`${period}-01T12:00:00Z`);
  if (Number.isNaN(base.getTime())) return new Date().toISOString().slice(0, 10);
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 15)).toISOString().slice(0, 10);
}

function communityPaymentDefaults(community: any) {
  return {
    accountNumber: String(community?.defaultAccountNumber || community?.accountNumber || community?.bankAccount || community?.paymentSettings?.accountNumber || community?.paymentDefaults?.accountNumber || "").replace(/\D/g, ""),
    recipientName: String(community?.recipientName || community?.receiverName || community?.transferName || community?.paymentSettings?.recipientName || community?.paymentDefaults?.recipientName || community?.name || "").trim(),
    recipientAddress: String(community?.recipientAddress || community?.receiverAddress || community?.transferAddress || community?.paymentSettings?.recipientAddress || community?.paymentDefaults?.recipientAddress || "").trim(),
  };
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const communityId = String(body.communityId || "").trim();
    const paymentId = String(body.paymentId || "").trim();
    if (!communityId || !paymentId) return NextResponse.json({ error: "Missing communityId or paymentId" }, { status: 400 });

    const db = getAdminDb();
    const paymentRef = db.doc(`communities/${communityId}/payments/${paymentId}`);
    const paymentSnap = await paymentRef.get();
    if (!paymentSnap.exists) return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    const payment = { id: paymentSnap.id, ...(paymentSnap.data() as any) };

    if (payment.matched && payment.flatId) {
      return NextResponse.json({ ok: true, alreadyMatched: true, payment });
    }

    const [flatsSnap, settlementsSnap, communitySnap] = await Promise.all([
      db.collection(`communities/${communityId}/flats`).limit(300).get(),
      db.collection(`communities/${communityId}/settlements`).limit(400).get(),
      db.doc(`communities/${communityId}`).get(),
    ]);

    const flatCandidates = flatsSnap.docs.map((d) => ({
      id: d.id,
      flatLabel: d.get("flatLabel") || `${d.get("street") || ""} ${d.get("buildingNo") || ""}/${d.get("apartmentNo") || ""}`.trim(),
      residentName: d.get("residentName") || d.get("displayName") || `${d.get("name") || ""} ${d.get("surname") || ""}`.trim(),
      email: d.get("email") || "",
      street: d.get("street") || d.get("streetName") || "",
      buildingNo: d.get("buildingNo") || d.get("buildingId") || "",
      apartmentNo: d.get("apartmentNo") || d.get("flatNumber") || "",
    }));
    const settlementCandidates = settlementsSnap.docs.slice(0, 200).map((d) => ({
      id: d.id,
      flatId: d.get("flatId") || "",
      flatLabel: d.get("flatLabel") || "",
      period: d.get("period") || "",
      balanceCents: d.get("balanceCents") || 0,
      paymentRef: d.get("paymentRef") || d.get("paymentTitle") || d.get("transferTitle") || "",
      transferTitle: d.get("transferTitle") || "",
    }));

    const explicitPaymentRef = normalizePaymentRef(payment.paymentRef || extractPaymentRef(`${payment.title || ""} ${payment.code || ""} ${payment.source || ""}`));
    let suggestion: any = null;
    if (explicitPaymentRef) {
      const direct = settlementCandidates.find((candidate) => normalizePaymentRef(candidate.paymentRef) === explicitPaymentRef);
      if (direct) {
        suggestion = { flatId: direct.flatId, settlementId: direct.id, confidence: 0.99, reason: `Dopasowanie po paymentRef ${explicitPaymentRef}.`, needsReview: false };
      }
    }

    if (!suggestion) {
      suggestion = await suggestPaymentMatch({
        payment: {
          title: payment.title || payment.source || "",
          amountCents: payment.amountCents || 0,
          amount: payment.amount || 0,
          period: payment.period || "",
          code: explicitPaymentRef || payment.code || "",
          source: payment.source || "",
          paymentRef: explicitPaymentRef || "",
        },
        flatCandidates,
        settlementCandidates,
      });
    }

    const confidence = Number((suggestion as any).confidence || 0);
    const suggestedFlatId = String((suggestion as any).flatId || "").trim();
    const suggestedSettlementId = String((suggestion as any).settlementId || "").trim();
    const shouldApply = !!suggestedFlatId && confidence >= 0.84 && !(suggestion as any).needsReview;

    if (!shouldApply) {
      await paymentRef.set({ aiSuggestion: suggestion, matchedBy: "REVIEW", status: "REVIEW", updatedAtMs: Date.now() }, { merge: true });
      await db.collection(`communities/${communityId}/reviewQueue`).add({ type: "PAYMENT_AI_REVIEW", paymentId, suggestion, status: "OPEN", createdAtMs: Date.now() });
      return NextResponse.json({ ok: true, applied: false, suggestion });
    }

    const settlementId = suggestedSettlementId || `${suggestedFlatId}_${String(payment.period || new Date().toISOString().slice(0, 7))}`;
    const settlementRef = db.doc(`communities/${communityId}/settlements/${settlementId}`);
    const settlementSnap = await settlementRef.get();
    const settlement = settlementSnap.exists ? (settlementSnap.data() as any) : {};
    const community = communitySnap.data() || {};
    const defaults = communityPaymentDefaults(community);
    const amountCents = Number(payment.amountCents || Math.round(Number(payment.amount || 0) * 100) || 0);
    const chargesCents = Number(settlement.chargesCents || settlement.totalChargesCents || 0);
    const paymentsCents = Number(settlement.paymentsCents || settlement.totalPaymentsCents || 0) + amountCents;
    const flatData = flatCandidates.find((f) => f.id === suggestedFlatId);
    const period = String(payment.period || settlement.period || new Date().toISOString().slice(0, 7));
    const paymentRefValue = ensurePaymentRef(
      settlement.paymentRef || settlement.paymentTitle || settlement.transferTitle || explicitPaymentRef,
      {
        communityId,
        flatId: suggestedFlatId,
        flatLabel: settlement.flatLabel || flatData?.flatLabel || suggestedFlatId,
        street: settlement.street || flatData?.street || "",
        buildingNo: settlement.buildingNo || flatData?.buildingNo || "",
        apartmentNo: settlement.apartmentNo || flatData?.apartmentNo || "",
        period,
      },
    );

    await settlementRef.set({
      flatId: suggestedFlatId,
      flatLabel: settlement.flatLabel || flatData?.flatLabel || suggestedFlatId,
      residentName: settlement.residentName || flatData?.residentName || "",
      period,
      paymentRef: paymentRefValue,
      paymentTitle: paymentRefValue,
      transferTitle: paymentRefValue,
      paymentCode: paymentRefValue,
      chargesCents,
      totalChargesCents: Number(settlement.totalChargesCents || chargesCents),
      paymentsCents,
      totalPaymentsCents: paymentsCents,
      balanceCents: chargesCents - paymentsCents,
      accountNumber: settlement.accountNumber || defaults.accountNumber,
      bankAccount: settlement.bankAccount || settlement.accountNumber || defaults.accountNumber,
      transferName: settlement.transferName || defaults.recipientName,
      receiverName: settlement.receiverName || settlement.transferName || defaults.recipientName,
      transferAddress: settlement.transferAddress || defaults.recipientAddress,
      receiverAddress: settlement.receiverAddress || settlement.transferAddress || defaults.recipientAddress,
      dueDate: settlement.dueDate || periodToDueDate(period),
      status: settlement.status || "DRAFT",
      isPublished: Boolean(settlement.isPublished),
      createdAtMs: Number(settlement.createdAtMs || Date.now()),
      updatedAtMs: Date.now(),
    }, { merge: true });

    await paymentRef.set({
      flatId: suggestedFlatId,
      settlementId,
      paymentRef: paymentRefValue,
      matched: true,
      matchedBy: explicitPaymentRef ? "PAYMENT_REF" : "AI_HINT",
      status: "MATCHED",
      aiSuggestion: suggestion,
      updatedAtMs: Date.now(),
    }, { merge: true });

    return NextResponse.json({ ok: true, applied: true, settlementId, suggestion });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "AI payment apply error" }, { status: 500 });
  }
}
