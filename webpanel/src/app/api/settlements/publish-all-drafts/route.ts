import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/server/firebaseAdmin";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const communityId = String(body.communityId || "").trim();
    if (!communityId) return NextResponse.json({ error: "Missing communityId" }, { status: 400 });

    const adminDb = getAdminDb();
    const snap = await adminDb.collection(`communities/${communityId}/settlements`).where("isPublished", "!=", true).limit(500).get();
    const batch = adminDb.batch();
    snap.docs.forEach((doc) => { const data:any = doc.data() || {}; const period = String(data.period || "").trim(); batch.set(doc.ref, { isPublished: true, status: "PUBLISHED", publishedAtMs: Date.now(), updatedAtMs: Date.now(), archiveMonth: period }, { merge: true }); });
    await batch.commit();
    return NextResponse.json({ ok: true, published: snap.size });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Publish all error" }, { status: 500 });
  }
}
