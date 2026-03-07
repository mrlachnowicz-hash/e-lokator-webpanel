import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/server/firebaseAdmin";

export const runtime = "nodejs";

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
    await ref.set({ isPublished: true, status: "PUBLISHED", publishedAtMs: Date.now(), updatedAtMs: Date.now() }, { merge: true });
    return NextResponse.json({ ok: true, settlementId });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Publish error" }, { status: 500 });
  }
}
