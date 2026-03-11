import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/server/firebaseAdmin";
import { buildStablePaymentTitle, normalizeAccountNumber, normalizePaymentRef } from "@/lib/paymentRefs";

export const runtime = "nodejs";

type Flat = Record<string, any> & { id: string };

function safe(value: any) { return String(value ?? "").trim(); }
function norm(value: any) {
  return safe(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
function normId(value: any) {
  return norm(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function normalizeScope(value: any) {
  const raw = safe(value).toUpperCase();
  if (["LOCAL", "LOKAL"].includes(raw)) return "FLAT";
  if (["BUDYNEK"].includes(raw)) return "BUILDING";
  if (["KLATKA", "ENTRANCE"].includes(raw)) return "STAIRCASE";
  if (["WSPOLNOTA"].includes(raw)) return "COMMUNITY";
  if (["WSPOLNE", "CZESCI_WSPOLNE"].includes(raw)) return "COMMON";
  return ["FLAT", "BUILDING", "STAIRCASE", "COMMON", "COMMUNITY"].includes(raw) ? raw : "COMMON";
}
function settlementDocId(flatId: string, period: string) {
  return `${flatId}_${period}`.replace(/[^\w\-]/g, "_");
}
function valueOr(...values: any[]) {
  for (const value of values) {
    const v = String(value ?? "").trim();
    if (v) return v;
  }
  return "";
}
function readCommunityDefaults(data: any) {
  return {
    accountNumber: valueOr(data?.defaultAccountNumber, data?.accountNumber, data?.bankAccount, data?.paymentSettings?.accountNumber, data?.paymentDefaults?.accountNumber),
    recipientName: valueOr(data?.recipientName, data?.receiverName, data?.transferName, data?.paymentSettings?.recipientName, data?.paymentDefaults?.recipientName),
    recipientAddress: valueOr(data?.recipientAddress, data?.receiverAddress, data?.transferAddress, data?.paymentSettings?.recipientAddress, data?.paymentDefaults?.recipientAddress),
  };
}
function flatLabel(flat: any) {
  return valueOr(flat?.flatLabel, `${safe(flat?.street || flat?.streetName)} ${safe(flat?.buildingNo || flat?.buildingId)}/${safe(flat?.apartmentNo || flat?.flatNumber)}`.trim(), flat?.id);
}

function matchFlats(flats: Flat[], assignment: any, parsed: any, scope: string) {
  const streetId = safe(assignment?.streetId || parsed?.streetId || parsed?.suggestedStreetId);
  const streetName = safe(assignment?.streetName || parsed?.streetName || parsed?.suggestedStreetName || parsed?.street);
  const buildingId = safe(assignment?.buildingId || parsed?.buildingId || parsed?.suggestedBuildingId || parsed?.buildingNo);
  const staircaseId = safe(assignment?.staircaseId || parsed?.staircaseId || parsed?.suggestedStaircaseId);
  const flatId = safe(assignment?.flatId || parsed?.flatId || parsed?.suggestedFlatId);
  const apartmentNo = safe(assignment?.apartmentNo || parsed?.apartmentNo || parsed?.suggestedApartmentNo || parsed?.flatNumber);
  const wantedStreetId = normId(streetId || streetName);
  const wantedBuilding = norm(buildingId);
  const wantedStaircase = norm(staircaseId);
  const wantedApartment = norm(apartmentNo);

  const matches = flats.filter((flat) => {
    const flatStreetId = normId(flat.streetId || flat.street || flat.streetName);
    const flatBuilding = norm(flat.buildingNo || flat.buildingId);
    const flatStaircase = norm(flat.staircaseId || flat.staircase || flat.entranceId || flat.entrance || flat.klatka);
    const flatApartment = norm(flat.apartmentNo || flat.flatNumber);
    if (wantedStreetId && flatStreetId !== wantedStreetId) return false;
    if (wantedBuilding && flatBuilding !== wantedBuilding) return false;
    if (wantedStaircase && flatStaircase !== wantedStaircase) return false;
    if (scope === "FLAT" && wantedApartment && flatApartment !== wantedApartment) return false;
    return true;
  });

  if (scope === "COMMUNITY") return flats;
  if (flatId) {
    const direct = flats.find((flat) => flat.id === flatId);
    if (direct) {
      if (scope === "FLAT") return [direct];
      const directStreet = normId(direct.streetId || direct.street || direct.streetName);
      const directBuilding = norm(direct.buildingNo || direct.buildingId);
      const directStair = norm(direct.staircaseId || direct.staircase || direct.entranceId || direct.entrance || direct.klatka);
      if (scope === "BUILDING" || scope === "COMMON") return flats.filter((flat) => normId(flat.streetId || flat.street || flat.streetName) === directStreet && norm(flat.buildingNo || flat.buildingId) === directBuilding);
      if (scope === "STAIRCASE") return flats.filter((flat) => normId(flat.streetId || flat.street || flat.streetName) === directStreet && norm(flat.buildingNo || flat.buildingId) === directBuilding && norm(flat.staircaseId || flat.staircase || flat.entranceId || flat.entrance || flat.klatka) === directStair);
    }
  }
  if (scope === "FLAT") return matches.slice(0, 1);
  if (matches.length) return matches;
  if (wantedStreetId || wantedBuilding || wantedStaircase) {
    return flats.filter((flat) => {
      const flatStreetId = normId(flat.streetId || flat.street || flat.streetName);
      const flatBuilding = norm(flat.buildingNo || flat.buildingId);
      const flatStaircase = norm(flat.staircaseId || flat.staircase || flat.entranceId || flat.entrance || flat.klatka);
      return (!wantedStreetId || flatStreetId === wantedStreetId)
        && (!wantedBuilding || flatBuilding === wantedBuilding)
        && (scope !== "STAIRCASE" || !wantedStaircase || flatStaircase === wantedStaircase);
    });
  }
  return flats;
}

async function rebuildSettlement(adminDb: any, communityId: string, flat: Flat, period: string, communityData: any) {
  const [chargesSnap, paymentsSnap, draftSnap, publishedSnap] = await Promise.all([
    adminDb.collection(`communities/${communityId}/charges`).where("flatId", "==", flat.id).where("period", "==", period).get(),
    adminDb.collection(`communities/${communityId}/payments`).where("flatId", "==", flat.id).where("period", "==", period).get().catch(async () => ({ docs: [] as any[] })),
    adminDb.doc(`communities/${communityId}/settlementDrafts/${settlementDocId(flat.id, period)}`).get(),
    adminDb.doc(`communities/${communityId}/settlements/${settlementDocId(flat.id, period)}`).get(),
  ]);
  const existing: any = draftSnap.exists ? draftSnap.data() : (publishedSnap.exists ? publishedSnap.data() : {});
  const totalChargesCents = (chargesSnap.docs as any[]).reduce((sum: number, d: any) => sum + Number(d?.data?.()?.amountCents || 0), 0);
  const totalPaymentsCents = (paymentsSnap.docs as any[]).reduce((sum: number, d: any) => sum + Number(d?.data?.()?.amountCents || 0), 0);
  const balanceCents = totalChargesCents - totalPaymentsCents;
  const defaults = readCommunityDefaults(communityData);
  const paymentRef = normalizePaymentRef(existing?.paymentRef || existing?.paymentTitle || existing?.transferTitle) || buildStablePaymentTitle({
    communityId,
    flatId: flat.id,
    street: flat.street || flat.streetName,
    buildingNo: flat.buildingNo || flat.buildingId,
    apartmentNo: flat.apartmentNo || flat.flatNumber,
    flatLabel: flatLabel(flat),
    period,
  });
  const ref = adminDb.doc(`communities/${communityId}/settlementDrafts/${settlementDocId(flat.id, period)}`);
  await ref.set({
    id: settlementDocId(flat.id, period),
    communityId,
    flatId: flat.id,
    flatLabel: flatLabel(flat),
    street: valueOr(flat.street, flat.streetName),
    buildingNo: valueOr(flat.buildingNo, flat.buildingId),
    apartmentNo: valueOr(flat.apartmentNo, flat.flatNumber),
    period,
    dueDate: `${period}-15`,
    paymentRef,
    paymentTitle: paymentRef,
    paymentCode: paymentRef,
    transferTitle: paymentRef,
    chargesCents: totalChargesCents,
    totalChargesCents,
    paymentsCents: totalPaymentsCents,
    totalPaymentsCents,
    balanceCents,
    totalDueCents: balanceCents,
    transferName: valueOr(existing?.transferName, existing?.receiverName, flat.recipientName, flat.receiverName, defaults.recipientName),
    receiverName: valueOr(existing?.receiverName, existing?.transferName, flat.receiverName, flat.recipientName, defaults.recipientName),
    transferAddress: valueOr(existing?.transferAddress, existing?.receiverAddress, flat.recipientAddress, flat.receiverAddress, defaults.recipientAddress),
    receiverAddress: valueOr(existing?.receiverAddress, existing?.transferAddress, flat.receiverAddress, flat.recipientAddress, defaults.recipientAddress),
    accountNumber: normalizeAccountNumber(valueOr(existing?.accountNumber, existing?.bankAccount, flat.accountNumber, flat.bankAccount, defaults.accountNumber)),
    bankAccount: normalizeAccountNumber(valueOr(existing?.bankAccount, existing?.accountNumber, flat.bankAccount, flat.accountNumber, defaults.accountNumber)),
    residentName: valueOr(existing?.residentName, flat.displayName, flat.name, flat.payerName),
    residentEmail: valueOr(existing?.residentEmail, flat.email, flat.payerEmail),
    status: "DRAFT",
    isPublished: false,
    updatedAtMs: Date.now(),
    createdAtMs: Number(existing?.createdAtMs || Date.now()),
  }, { merge: true });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const communityId = safe(body.communityId);
    const invoiceId = safe(body.invoiceId);
    const assignment = body.assignment || {};
    if (!communityId || !invoiceId) return NextResponse.json({ error: "Missing communityId or invoiceId" }, { status: 400 });

    const adminDb = getAdminDb();
    let ref = adminDb.doc(`communities/${communityId}/invoices/${invoiceId}`);
    let snap = await ref.get();
    let sourceCollection: "invoices" | "ksefInvoices" = "invoices";
    if (!snap.exists) {
      ref = adminDb.doc(`communities/${communityId}/ksefInvoices/${invoiceId}`);
      snap = await ref.get();
      sourceCollection = "ksefInvoices";
    }
    if (!snap.exists) return NextResponse.json({ error: "Faktura nie istnieje." }, { status: 404 });

    const inv: any = snap.data() || {};
    const status = safe(inv.status).toUpperCase();
    if (["PRZENIESIONA_DO_SZKICU", "ARCHIVED"].includes(status)) {
      return NextResponse.json({ ok: true, alreadyArchived: true, sourceCollection, scope: normalizeScope(assignment.scope || inv.scope || inv.parsed?.scope), chargesCreated: Number(inv.settlementDraftCount || 0) }, { status: 200 });
    }

    const parsed = inv.parsed || {};
    const period = safe(assignment.period || parsed.period || inv.period || inv.ai?.suggestion?.period);
    const category = safe(assignment.category || parsed.category || inv.category || inv.ai?.suggestion?.category || "INNE");
    const totalCents = Number(parsed.totalGrossCents || parsed.amountCents || inv.totalGrossCents || inv.amountCents || 0);
    const scope = normalizeScope(assignment.scope || inv.scope || parsed.scope || parsed.allocationType || inv.ai?.suggestion?.scope || inv.ai?.suggestion?.allocationType || "COMMON");
    const archiveMonth = safe(period || String(parsed.issueDate || inv.issueDate || "").slice(0, 7));
    if (!period) return NextResponse.json({ error: "Brak okresu faktury." }, { status: 400 });
    if (!(totalCents > 0)) return NextResponse.json({ error: "Brak kwoty na fakturze." }, { status: 400 });

    const [flatsSnap, communitySnap] = await Promise.all([
      adminDb.collection(`communities/${communityId}/flats`).get(),
      adminDb.doc(`communities/${communityId}`).get(),
    ]);
    const flats = flatsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as Flat[];
    const targetFlats = matchFlats(flats, assignment, parsed, scope);
    if (!targetFlats.length) return NextResponse.json({ error: "Brak lokali do rozliczenia dla tej faktury." }, { status: 400 });

    const useArea = scope !== "FLAT" && targetFlats.some((flat) => Number(flat.areaM2 || 0) > 0);
    const totalWeight = scope === "FLAT" ? 1 : (useArea ? targetFlats.reduce((sum, flat) => sum + Math.max(0, Number(flat.areaM2 || 0)), 0) : targetFlats.length);

    const previousCharges = await adminDb.collection(`communities/${communityId}/charges`).where("invoiceId", "==", invoiceId).get();
    let batch = adminDb.batch();
    let ops = 0;
    const flush = async () => {
      if (ops > 0) await batch.commit();
      batch = adminDb.batch();
      ops = 0;
    };
    previousCharges.docs.forEach((d) => { batch.delete(d.ref); ops += 1; });
    if (ops >= 400) await flush();

    const now = Date.now();
    const createdCharges: any[] = [];
    let allocated = 0;
    for (let i = 0; i < targetFlats.length; i += 1) {
      const flat = targetFlats[i];
      const weight = scope === "FLAT" ? 1 : (useArea ? Math.max(0, Number(flat.areaM2 || 0)) : 1);
      let part = scope === "FLAT" ? totalCents : Math.floor((totalCents * weight) / Math.max(1, totalWeight));
      if (i === targetFlats.length - 1) part = totalCents - allocated;
      allocated += part;
      const charge = {
        createdAtMs: now,
        updatedAtMs: now,
        source: inv.source || "WEBPANEL_OCR",
        invoiceId,
        flatId: flat.id,
        buildingId: valueOr(flat.buildingId, flat.buildingNo, assignment.buildingId, parsed.buildingId),
        streetId: valueOr(flat.streetId, assignment.streetId, parsed.streetId, parsed.suggestedStreetId),
        staircaseId: valueOr(flat.staircaseId, flat.staircase, flat.entranceId, assignment.staircaseId, parsed.staircaseId),
        category,
        period,
        amountCents: part,
        currency: safe(inv.currency || parsed.currency || "PLN") || "PLN",
        status: "OPEN",
        scope,
        allocationMethod: scope === "FLAT" ? "DIRECT" : (useArea ? "AREA" : "EQUAL"),
        invoiceNumber: safe(inv.invoiceNumber || parsed.invoiceNumber),
        supplierName: safe(inv.supplierName || inv.vendorName || parsed.sellerName),
        invoiceTotalCents: totalCents,
        totalGrossCents: totalCents,
      };
      createdCharges.push(charge);
      const chargeRef = adminDb.collection(`communities/${communityId}/charges`).doc();
      batch.set(chargeRef, charge);
      ops += 1;
      if (ops >= 400) await flush();
    }
    await flush();

    for (const flat of targetFlats) {
      await rebuildSettlement(adminDb as any, communityId, flat, period, communitySnap.data() || {});
    }

    await ref.set({
      status: "PRZENIESIONA_DO_SZKICU",
      approvedAtMs: now,
      archivedAtMs: now,
      archiveMonth: archiveMonth || period,
      isArchived: true,
      movedToDraftAtMs: now,
      settlementDraftCount: createdCharges.length,
      lastDraftPeriod: period,
      assigned: {
        scope,
        streetId: safe(assignment.streetId || parsed.streetId || parsed.suggestedStreetId) || null,
        streetName: safe(assignment.streetName || parsed.streetName || parsed.suggestedStreetName) || null,
        buildingId: safe(assignment.buildingId || parsed.buildingId || parsed.suggestedBuildingId) || null,
        staircaseId: safe(assignment.staircaseId || parsed.staircaseId || parsed.suggestedStaircaseId) || null,
        flatId: safe(assignment.flatId || parsed.flatId || parsed.suggestedFlatId) || null,
        apartmentNo: safe(assignment.apartmentNo || parsed.apartmentNo || parsed.suggestedApartmentNo) || null,
        category,
        period,
        affectedFlatIds: targetFlats.map((flat) => flat.id),
      },
    }, { merge: true });

    return NextResponse.json({ ok: true, sourceCollection, chargesCreated: createdCharges.length, affectedFlatIds: targetFlats.map((flat) => flat.id), scope, archived: true, archiveMonth: archiveMonth || period });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Stage invoice error" }, { status: 500 });
  }
}
