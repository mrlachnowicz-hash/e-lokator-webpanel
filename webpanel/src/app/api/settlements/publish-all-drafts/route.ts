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
    const periodFilter = String(body.period || "").trim();
    if (!communityId) return NextResponse.json({ error: "Missing communityId" }, { status: 400 });

    const adminDb = getAdminDb();
    const allSnap = await adminDb.collection(`communities/${communityId}/settlements`).get();
    const docs = allSnap.docs.filter((doc) => {
      const data: any = doc.data() || {};
      const isDraft = data.isPublished !== true;
      const samePeriod = !periodFilter || String(data.period || "").trim() === periodFilter;
      return isDraft && samePeriod;
    });

    if (docs.length === 0) {
      return NextResponse.json({ ok: true, published: 0, publishedCount: 0, emailFallbackCount: 0, settlementIds: [] });
    }

    const now = Date.now();
    const batch = adminDb.batch();
    for (const doc of docs) {
      const data: any = doc.data() || {};
      batch.set(doc.ref, {
        isPublished: true,
        status: "PUBLISHED",
        publishedAtMs: now,
        updatedAtMs: now,
        archiveMonth: String(data.period || data.archiveMonth || "").trim(),
        sentAtMs: now,
      }, { merge: true });
    }
    await batch.commit();

    let emailFallbackCount = 0;
    const origin = new URL(req.url).origin;
    for (const settlementDoc of docs) {
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

    return NextResponse.json({
      ok: true,
      published: docs.length,
      publishedCount: docs.length,
      emailFallbackCount,
      settlementIds: docs.map((doc) => doc.id),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Publish all error" }, { status: 500 });
  }
}
