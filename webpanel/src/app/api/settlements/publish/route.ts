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
    const settlementId = safe(body?.settlementId);
    if (!communityId || !settlementId) return NextResponse.json({ error: "Missing communityId or settlementId" }, { status: 400 });

    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const { db: adminDb } = await requirePanelAccess(req, { communityId });
    const draftRef = adminDb.doc(`communities/${communityId}/settlementDrafts/${settlementId}`);
    const publishedRef = adminDb.doc(`communities/${communityId}/settlements/${settlementId}`);
    const [draftSnap, publishedSnap] = await Promise.all([draftRef.get(), publishedRef.get()]);
    const sourceSnap = draftSnap.exists ? draftSnap : publishedSnap;
    if (!sourceSnap.exists) return NextResponse.json({ error: "Settlement not found" }, { status: 404 });
    const data: any = sourceSnap.data() || {};
    const period = safe(data.period || data.archiveMonth);
    const now = Date.now();

    await publishedRef.set({ ...data, isPublished: true, status: "PUBLISHED", publishedAtMs: now, updatedAtMs: now, archiveMonth: period }, { merge: true });
    if (draftSnap.exists) await draftRef.delete();

    let emailFallback = false;
    if (data.flatId) {
      const flatSnap = await adminDb.doc(`communities/${communityId}/flats/${data.flatId}`).get().catch(() => null as any);
      const flat: any = flatSnap?.exists ? flatSnap.data() : {};
      const candidateUid = safe(flat?.residentUid || flat?.userId || data?.residentUid || data?.userId);
      const hasAppUser = await hasRealAppUser(adminDb, candidateUid);
      const email = safe(data.email || data.residentEmail || flat?.email);
      if (!hasAppUser && email) {
        emailFallback = true;
        if (token) await sendEmailFallback(new URL(req.url).origin, settlementId, communityId, token);
      }
    }

    return NextResponse.json({ ok: true, settlementId, published: true, emailFallback });
  } catch (error: any) {
    if (error instanceof PanelAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: error?.message || "Publish error" }, { status: 500 });
  }
}
