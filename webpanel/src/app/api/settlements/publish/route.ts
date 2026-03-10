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
    const settlementId = String(body.settlementId || "").trim();
    if (!communityId || !settlementId) return NextResponse.json({ error: "Missing communityId or settlementId" }, { status: 400 });

    const adminDb = getAdminDb();
    const ref = adminDb.doc(`communities/${communityId}/settlements/${settlementId}`);
    const snap = await ref.get();
    if (!snap.exists) return NextResponse.json({ error: "Settlement not found" }, { status: 404 });
    const data: any = snap.data() || {};
    const period = String(data.period || data.archiveMonth || "").trim();
    const now = Date.now();

    await ref.set({
      isPublished: true,
      status: "PUBLISHED",
      publishedAtMs: now,
      updatedAtMs: now,
      archiveMonth: period,
      sentAtMs: now,
    }, { merge: true });

    let emailFallback = false;
    if (data.flatId) {
      const flatSnap = await adminDb.doc(`communities/${communityId}/flats/${data.flatId}`).get().catch(() => null as any);
      const flat: any = flatSnap?.exists ? flatSnap.data() : {};
      const hasAppUser = !!String(flat?.residentUid || flat?.userId || data?.residentUid || data?.userId || "").trim();
      const email = String(data.email || data.residentEmail || flat?.email || "").trim();
      if (!hasAppUser && email) {
        emailFallback = true;
        const origin = new URL(req.url).origin;
        await sendEmailFallback(origin, settlementId, communityId);
      }
    }

    return NextResponse.json({ ok: true, settlementId, published: true, emailFallback });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Publish error" }, { status: 500 });
  }
}
