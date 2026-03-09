import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/server/firebaseAdmin";
import { suggestInvoice } from "@/lib/server/ai/invoice";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const communityId = String(body.communityId || "").trim();
    const invoiceId = String(body.invoiceId || "").trim();
    if (!communityId || !invoiceId) return NextResponse.json({ error: "Missing communityId or invoiceId" }, { status: 400 });

    const adminDb = getAdminDb();
    const invoiceRef = adminDb.doc(`communities/${communityId}/invoices/${invoiceId}`);
    const snap = await invoiceRef.get();
    if (!snap.exists) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    const invoice = { id: snap.id, ...(snap.data() as any) };

    const flatsSnap = await adminDb.collection(`communities/${communityId}/flats`).limit(100).get();
    const buildings = Array.from(new Set(flatsSnap.docs.map((d) => String(d.get("buildingId") || "")).filter(Boolean)));
    const knownFlats = flatsSnap.docs.slice(0, 50).map((d) => ({ id: d.id, flatLabel: d.get("flatLabel") || d.get("apartmentNo") || d.id }));

    const suggestion = await suggestInvoice({
      invoice: {
        vendorName: invoice.vendorName || "",
        title: invoice.title || "",
        period: invoice.period || "",
        category: invoice.category || "",
        totalGrossCents: invoice.totalGrossCents || invoice.amountCents || 0,
      },
      knownBuildings: buildings,
      knownFlats,
    });

    const status = Number(suggestion.confidence || 0) >= 0.85 && !suggestion.needsReview ? "READY_TO_STAGE" : "SUGGESTED";

    await invoiceRef.set({
      ai: { suggestion, updatedAtMs: Date.now() },
      status,
      updatedAtMs: Date.now(),
    }, { merge: true });

    if (suggestion.needsReview) {
      await adminDb.collection(`communities/${communityId}/reviewQueue`).add({
        type: "INVOICE_AI_REVIEW",
        invoiceId,
        confidence: suggestion.confidence || 0,
        suggestion,
        status: "OPEN",
        createdAtMs: Date.now(),
      });
    }

    return NextResponse.json({ ok: true, suggestion, status });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "AI invoice error" }, { status: 500 });
  }
}
