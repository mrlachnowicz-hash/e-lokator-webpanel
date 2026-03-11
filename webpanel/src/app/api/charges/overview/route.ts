import { NextRequest, NextResponse } from "next/server";
import { getAdminApp, getAdminDb } from "@/lib/server/firebaseAdmin";

function safe(value: unknown) { return String(value || "").trim(); }

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return NextResponse.json({ error: "Brak tokenu autoryzacji." }, { status: 401 });

    const adminApp = getAdminApp();
    const decoded = await adminApp.auth().verifyIdToken(token);
    const db = getAdminDb();
    const meSnap = await db.doc(`users/${decoded.uid}`).get();
    const me = meSnap.data() || {};
    const role = safe(me.role).toUpperCase();
    if (!["MASTER", "ACCOUNTANT", "ADMIN"].includes(role)) {
      return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const communityId = safe(body?.communityId || me.communityId || me.customerId);
    if (!communityId) return NextResponse.json({ error: "Brak communityId." }, { status: 400 });

    const [draftSnap, legacyDraftSnap, publishedSnap] = await Promise.all([
      db.collection(`communities/${communityId}/settlementDrafts`).get(),
      db.collection(`settlementDrafts`).where('communityId', '==', communityId).get().catch(() => ({ docs: [] as any[] } as any)),
      db.collection(`communities/${communityId}/settlements`).get(),
    ]);

    const dedupeDrafts = new Map<string, any>();
    for (const d of draftSnap.docs) dedupeDrafts.set(d.id, { id: d.id, ...(d.data() || {}), __collection: "settlementDrafts", isPublished: false });
    for (const d of legacyDraftSnap.docs || []) if (!dedupeDrafts.has(d.id)) dedupeDrafts.set(d.id, { id: d.id, ...(d.data() || {}), __collection: "settlementDrafts", isPublished: false });
    const drafts: any[] = Array.from(dedupeDrafts.values()).sort((a: any, b: any) => Number(b?.updatedAtMs || b?.createdAtMs || 0) - Number(a?.updatedAtMs || a?.createdAtMs || 0));
    const settlements: any[] = publishedSnap.docs
      .map((d: any) => ({ id: d.id, ...(d.data() || {}), __collection: "settlements", isPublished: true }))
      .sort((a: any, b: any) => Number(b?.updatedAtMs || b?.createdAtMs || 0) - Number(a?.updatedAtMs || a?.createdAtMs || 0));

    return NextResponse.json({ ok: true, drafts, settlements });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Nie udało się pobrać rozliczeń." }, { status: 500 });
  }
}
