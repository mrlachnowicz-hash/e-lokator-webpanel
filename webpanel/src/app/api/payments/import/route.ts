import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAdminApp, getAdminDb } from "@/lib/server/firebaseAdmin";
import { buildStablePaymentTitle, ensurePaymentRef, extractPaymentRef, normalizePaymentRef } from "@/lib/server/paymentRefs";

export const runtime = "nodejs";

type ImportRow = {
  date?: string;
  title?: string;
  amount?: string | number;
  source?: string;
  code?: string;
  payerName?: string;
  payerAddress?: string;
};

const normalize = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const toCents = (v: unknown) => {
  const n = Number(String(v ?? 0).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const monthFromDate = (v: unknown) => {
  const s = String(v ?? "").trim();
  const m = s.match(/(20\d{2})[-./](\d{2})/);
  return m ? `${m[1]}-${m[2]}` : new Date().toISOString().slice(0, 7);
};

function paymentFingerprint(row: ImportRow, amountCents: number) {
  return crypto.createHash("sha256").update([
    String(row.date || "").trim(),
    String(row.title || "").trim().toUpperCase(),
    String(row.source || "").trim().toUpperCase(),
    String(row.code || "").trim().toUpperCase(),
    String(row.payerName || "").trim().toUpperCase(),
    String(row.payerAddress || "").trim().toUpperCase(),
    String(amountCents || 0),
  ].join("|"), "utf8").digest("hex");
}

function extractAnyPaymentRef(row: ImportRow) {
  return normalizePaymentRef(
    extractPaymentRef(`${row.title || ""} ${row.code || ""} ${row.source || ""} ${row.payerName || ""}`),
  );
}

function communityPaymentDefaults(community: any) {
  return {
    accountNumber: String(community?.defaultAccountNumber || community?.accountNumber || community?.bankAccount || community?.paymentSettings?.accountNumber || community?.paymentDefaults?.accountNumber || "").replace(/\D/g, ""),
    recipientName: String(community?.recipientName || community?.receiverName || community?.transferName || community?.paymentSettings?.recipientName || community?.paymentDefaults?.recipientName || community?.name || "").trim(),
    recipientAddress: String(community?.recipientAddress || community?.receiverAddress || community?.transferAddress || community?.paymentSettings?.recipientAddress || community?.paymentDefaults?.recipientAddress || "").trim(),
  };
}

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return NextResponse.json({ error: "Brak tokenu autoryzacji." }, { status: 401 });

    const adminApp = getAdminApp();
    const decoded = await adminApp.auth().verifyIdToken(token);
    const uid = decoded.uid;
    const db = getAdminDb();

    const body = await req.json();
    const communityId = String(body?.communityId || "").trim();
    const rows = Array.isArray(body?.rows) ? (body.rows as ImportRow[]) : [];
    if (!communityId || !rows.length) return NextResponse.json({ error: "Brak communityId albo pusty plik." }, { status: 400 });

    const userSnap = await db.collection("users").doc(uid).get();
    const me = userSnap.data() || {};
    const role = String((me as any).role || "").toUpperCase();
    const userCommunityId = String((me as any).communityId || (me as any).customerId || "").trim();
    if (!["MASTER", "ACCOUNTANT", "ADMIN"].includes(role)) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
    if (userCommunityId && userCommunityId !== communityId) return NextResponse.json({ error: "Inna wspólnota." }, { status: 403 });

    const [flatsSnap, settlementSnaps, paymentsSnap, communitySnap] = await Promise.all([
      db.collection(`communities/${communityId}/flats`).get(),
      Promise.all([
        db.collection(`communities/${communityId}/settlements`).get(),
        db.collection(`communities/${communityId}/settlementDrafts`).get(),
      ]) as Promise<[any, any]>,
      db.collection(`communities/${communityId}/payments`).get(),
      db.doc(`communities/${communityId}`).get(),
    ]);

    const flats = flatsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
    const [publishedSettlementsSnap, draftSettlementsSnap] = settlementSnaps;
    const publishedDocs = publishedSettlementsSnap.docs;
    const draftDocs = draftSettlementsSnap.docs;
    const settlementMap = new Map<string, any>();
    draftDocs.forEach((d: any) => settlementMap.set(d.id, { id: d.id, ...(d.data() as any), __collection: "settlementDrafts", isPublished: false }));
    publishedDocs.forEach((d: any) => settlementMap.set(d.id, { id: d.id, ...(d.data() as any), __collection: "settlements", isPublished: true }));
    const settlements = Array.from(settlementMap.values());
    const community = communitySnap.data() || {};
    const defaults = communityPaymentDefaults(community);

    const existingFingerprints = new Set(paymentsSnap.docs.map((d) => String((d.data() as any).importFingerprint || "")).filter(Boolean));
    const matchedPaymentKeys = new Set(paymentsSnap.docs.map((d) => String((d.data() as any).bankMatchKey || "")).filter(Boolean));
    const settlementByRef = new Map<string, any>();
    settlements.forEach((settlement: any) => {
      const refs = [settlement.paymentRef, settlement.paymentTitle, settlement.transferTitle, settlement.paymentCode]
        .map((x) => normalizePaymentRef(x || extractPaymentRef(x)))
        .filter(Boolean);
      if (refs.length === 0) {
        const fallback = buildStablePaymentTitle({
          communityId,
          flatId: settlement.flatId,
          flatLabel: settlement.flatLabel,
          street: settlement.street,
          buildingNo: settlement.buildingNo,
          apartmentNo: settlement.apartmentNo,
          period: settlement.period,
        });
        refs.push(fallback);
      }
      refs.forEach((ref) => settlementByRef.set(ref, settlement));
    });

    let matched = 0;
    let unmatched = 0;
    let duplicates = 0;
    const details: string[] = [];

    for (const row of rows) {
      const amountCents = toCents(row.amount);
      const period = monthFromDate(row.date);
      const importFingerprint = paymentFingerprint(row, amountCents);
      if (existingFingerprints.has(importFingerprint)) {
        duplicates += 1;
        details.push(`Pominięto duplikat importu: ${String(row.title || row.code || row.payerName || "wpłata")}.`);
        continue;
      }
      existingFingerprints.add(importFingerprint);

      const rawText = `${row.title || ""} ${row.source || ""} ${row.payerName || ""} ${row.payerAddress || ""} ${row.code || ""}`;
      const normalized = normalize(rawText);
      const detectedPaymentRef = extractAnyPaymentRef(row);
      let settlement: any = detectedPaymentRef ? settlementByRef.get(detectedPaymentRef) || null : null;
      let flat: any = settlement ? flats.find((f: any) => f.id === settlement.flatId) || null : null;
      let confidence = settlement ? 0.99 : 0;
      let matchReason = settlement ? `Dopasowanie po paymentRef ${detectedPaymentRef}.` : "Brak pewnego dopasowania.";

      if (!settlement) {
        let bestScore = 0;
        for (const candidate of settlements) {
          const candidateFlat = flats.find((f: any) => f.id === candidate.flatId) || null;
          const candidateRef = normalizePaymentRef(candidate.paymentRef || candidate.paymentTitle || candidate.transferTitle || candidate.paymentCode || "");
          const flatLabel = normalize(candidate.flatLabel || `${candidate.street || candidateFlat?.street || ""} ${candidate.buildingNo || candidateFlat?.buildingNo || ""}/${candidate.apartmentNo || candidateFlat?.apartmentNo || ""}`);
          const resident = normalize(candidate.residentName || candidateFlat?.residentName || candidateFlat?.displayName || `${candidateFlat?.name || ""} ${candidateFlat?.surname || ""}`);
          let score = 0;
          if (candidateRef && String(rawText).toUpperCase().includes(candidateRef)) score += 12;
          if (flatLabel && normalized.includes(flatLabel)) score += 6;
          if (resident && normalized.includes(resident)) score += 3;
          if (String(candidate.period || "") === period) score += 2;
          const due = Number(candidate.totalDueCents || candidate.balanceCents || 0);
          if (due > 0 && Math.abs(due - amountCents) <= 5) score += 4;
          else if (due > 0 && Math.abs(due - amountCents) <= 100) score += 2;
          if (score > bestScore) {
            bestScore = score;
            settlement = candidate;
            flat = candidateFlat;
          }
        }
        if (settlement && bestScore >= 8) {
          confidence = Math.min(0.96, 0.45 + bestScore / 20);
          matchReason = "Dopasowanie po tytule / lokalu / nazwisku / kwocie.";
        } else if (settlement && bestScore >= 5) {
          confidence = 0.68;
          matchReason = "Dopasowanie częściowe — wymaga sprawdzenia.";
        } else {
          settlement = null;
          flat = null;
        }
      }

      const base: any = {
        communityId,
        date: String(row.date || ""),
        title: String(row.title || "").trim(),
        source: String(row.source || "").trim(),
        code: detectedPaymentRef || String(row.code || "").trim(),
        payerName: String(row.payerName || "").trim(),
        payerAddress: String(row.payerAddress || "").trim(),
        amountCents,
        amount: amountCents / 100,
        period,
        paymentRef: detectedPaymentRef || "",
        importFingerprint,
        updatedAtMs: Date.now(),
        createdAtMs: Date.now(),
      };

      if (settlement && flat && confidence >= 0.84) {
        const settlementPaymentRef = ensurePaymentRef(
          settlement.paymentRef || settlement.paymentTitle || settlement.transferTitle || settlement.paymentCode || "",
          {
            communityId,
            flatId: settlement.flatId || flat.id,
            flatLabel: settlement.flatLabel || flat.flatLabel || `${flat.street || ""} ${flat.buildingNo || ""}/${flat.apartmentNo || ""}`.trim(),
            street: settlement.street || flat.street || "",
            buildingNo: settlement.buildingNo || flat.buildingNo || "",
            apartmentNo: settlement.apartmentNo || flat.apartmentNo || "",
            period: settlement.period || period,
          },
        );
        const bankMatchKey = `${settlement.id}|${importFingerprint}`;
        if (matchedPaymentKeys.has(bankMatchKey)) {
          duplicates += 1;
          details.push(`Pominięto ponowne księgowanie: ${base.title || settlementPaymentRef}.`);
          continue;
        }
        matchedPaymentKeys.add(bankMatchKey);
        matched += 1;

        const paymentRef = db.collection(`communities/${communityId}/payments`).doc();
        await paymentRef.set({
          ...base,
          paymentRef: settlementPaymentRef,
          matched: true,
          status: "MATCHED",
          matchedBy: confidence >= 0.98 ? "PAYMENT_REF" : "HEURISTIC",
          matchedAtMs: Date.now(),
          confidence,
          matchReason,
          bankMatchKey,
          flatId: flat.id,
          settlementId: settlement.id,
          residentName: settlement.residentName || flat.residentName || flat.displayName || `${flat.name || ""} ${flat.surname || ""}`.trim(),
          flatLabel: settlement.flatLabel || flat.flatLabel || `${flat.street || ""} ${flat.buildingNo || ""}/${flat.apartmentNo || ""}`.trim(),
        }, { merge: true });

        const prevPayments = Number(settlement.totalPaymentsCents || settlement.paymentsCents || 0);
        const totalCharges = Number(settlement.totalChargesCents || settlement.chargesCents || 0);
        const nextPayments = prevPayments + amountCents;
        await db.doc(`communities/${communityId}/${settlement.__collection || "settlementDrafts"}/${settlement.id}`).set({
          paymentRef: settlementPaymentRef,
          paymentTitle: settlementPaymentRef,
          transferTitle: settlementPaymentRef,
          paymentCode: settlementPaymentRef,
          accountNumber: settlement.accountNumber || defaults.accountNumber,
          bankAccount: settlement.bankAccount || settlement.accountNumber || defaults.accountNumber,
          transferName: settlement.transferName || defaults.recipientName,
          receiverName: settlement.receiverName || settlement.transferName || defaults.recipientName,
          transferAddress: settlement.transferAddress || defaults.recipientAddress,
          receiverAddress: settlement.receiverAddress || settlement.transferAddress || defaults.recipientAddress,
          totalPaymentsCents: nextPayments,
          paymentsCents: nextPayments,
          balanceCents: totalCharges - nextPayments,
          updatedAtMs: Date.now(),
        }, { merge: true });
        details.push(`Dopasowano: ${base.title || settlementPaymentRef} → ${settlement.flatLabel || flat.flatLabel || flat.id}.`);
      } else {
        unmatched += 1;
        const paymentRef = db.collection(`communities/${communityId}/payments`).doc();
        await paymentRef.set({
          ...base,
          matched: false,
          status: "REVIEW",
          matchedBy: "REVIEW",
          confidence,
          aiSuggestion: settlement ? { flatId: flat?.id || null, settlementId: settlement.id, confidence, reason: matchReason, needsReview: true } : null,
          matchReason,
        }, { merge: true });
        await db.collection(`communities/${communityId}/reviewQueue`).add({
          type: "PAYMENT_IMPORT_REVIEW",
          status: "OPEN",
          createdAtMs: Date.now(),
          paymentId: paymentRef.id,
          paymentTitle: base.title,
          amountCents,
          confidence,
          reason: matchReason,
          paymentRef: detectedPaymentRef || "",
          proposed: settlement ? { flatId: flat?.id || "", settlementId: settlement.id, flatLabel: settlement.flatLabel || flat?.flatLabel || "" } : null,
        });
      }
    }

    return NextResponse.json({ ok: true, matched, unmatched, duplicates, details });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Payment import error" }, { status: 500 });
  }
}
