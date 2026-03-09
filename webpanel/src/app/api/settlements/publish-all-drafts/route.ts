import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/server/firebaseAdmin";

export const runtime = "nodejs";

async function sendEmailFallback(origin: string, settlementId: string, communityId: string) {
  try {
    await fetch(`${origin}/api/settlements/${encodeURIComponent(settlementId)}/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ communityId }),
    });
  } catch {
    // mail fallback should not block publish
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const communityId = String(body.communityId || "").trim();
    if (!communityId) return NextResponse.json({ error: "Missing communityId" }, { status: 400 });

    const adminDb = getAdminDb();
    const snap = await adminDb.collection(`communities/${communityId}/settlements`).where("isPublished", "!=", true).limit(500).get();
    const now = Date.now();
    const batch = adminDb.batch();
    snap.docs.forEach((doc) => {
      const data: any = doc.data() || {};
      const period = String(data.period || "").trim();
      batch.set(doc.ref, { isPublished: true, status: "PUBLISHED", publishedAtMs: now, updatedAtMs: now, archiveMonth: period }, { merge: true });
    });
    await batch.commit();

    let emailFallbackCount = 0;
    const origin = new URL(req.url).origin;
    for (const settlementDoc of snap.docs) {
      const data: any = settlementDoc.data() || {};
      if (!data.flatId) continue;
      const flatSnap = await adminDb.doc(`communities/${communityId}/flats/${data.flatId}`).get().catch(() => null as any);
      const flat: any = flatSnap?.exists ? flatSnap.data() : {};
      const hasAppUser = !!String(flat?.residentUid || flat?.userId || data?.residentUid || data?.userId || "").trim();
      const email = String(data.email || data.residentEmail || flat?.email || "").trim();
      if (!hasAppUser && email) {
        emailFallbackCount += 1;
        await sendEmailFallback(origin, settlementDoc.id, communityId);
      }
    }

    return NextResponse.json({ ok: true, published: snap.size, emailFallbackCount });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Publish all error" }, { status: 500 });
  }
}
