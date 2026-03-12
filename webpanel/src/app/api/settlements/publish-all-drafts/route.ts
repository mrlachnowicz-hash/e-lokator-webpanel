import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/server/firebaseAdmin";
import { PanelAuthError, requirePanelAccess } from "@/lib/server/panelAuth";

export const runtime = "nodejs";

function safe(value: unknown): string {
  return String(value || "").trim();
}

async function hasRealAppUser(adminDb: FirebaseFirestore.Firestore, candidateUid: string) {
  const uid = safe(candidateUid);
  if (!uid || uid.startsWith("payer_") || uid.startsWith("shadow_")) return false;
  const userSnap = await adminDb.doc(`users/${uid}`).get().catch(() => null as any);
  if (!userSnap?.exists) return false;
  const user = userSnap.data() || {};
  const role = safe(user.role).toUpperCase();
  if (role === "REMOVED") return false;
  if (user.isShadow === true || user.placeholderResident === true) return false;
  if (user.removedAtMs != null) return false;
  return true;
}

async function sendEmailFallback(origin: string, settlementId: string, communityId: string, token: string) {
  try {
    await fetch(`${origin}/api/settlements/${encodeURIComponent(settlementId)}/send-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ communityId }),
    });
  } catch {}
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const communityId = safe(body?.communityId);
    const periodFilter = safe(body?.period);
    if (!communityId) return NextResponse.json({ error: "Missing communityId" }, { status: 400 });

    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const { db: adminDb } = await requirePanelAccess(req, { communityId });
    const allSnap = await adminDb.collection(`communities/${communityId}/settlementDrafts`).get();
    const docs = allSnap.docs.filter((doc) => !periodFilter || safe(doc.data()?.period) === periodFilter);
    if (!docs.length) return NextResponse.json({ ok: true, published: 0, publishedCount: 0, emailFallbackCount: 0, settlementIds: [] });

    const now = Date.now();
    for (const docSnap of docs) {
      const data: any = docSnap.data() || {};
      await adminDb.doc(`communities/${communityId}/settlements/${docSnap.id}`).set({ ...data, isPublished: true, status: "PUBLISHED", publishedAtMs: now, updatedAtMs: now, archiveMonth: safe(data.period || data.archiveMonth) }, { merge: true });
      await docSnap.ref.delete();
    }

    let emailFallbackCount = 0;
    const origin = new URL(req.url).origin;
    for (const settlementDoc of docs) {
      const data: any = settlementDoc.data() || {};
      if (!data.flatId) continue;
      const flatSnap = await adminDb.doc(`communities/${communityId}/flats/${data.flatId}`).get().catch(() => null as any);
      const flat: any = flatSnap?.exists ? flatSnap.data() : {};
      const candidateUid = safe(flat?.residentUid || flat?.userId || data?.residentUid || data?.userId);
      const hasAppUser = await hasRealAppUser(adminDb, candidateUid);
      const email = safe(data.email || data.residentEmail || flat?.email);
      if (!hasAppUser && email) {
        emailFallbackCount += 1;
        if (token) await sendEmailFallback(origin, settlementDoc.id, communityId, token);
      }
    }

    return NextResponse.json({ ok: true, published: docs.length, publishedCount: docs.length, emailFallbackCount, settlementIds: docs.map((doc) => doc.id) });
  } catch (error: any) {
    if (error instanceof PanelAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: error?.message || "Publish all error" }, { status: 500 });
  }
}
