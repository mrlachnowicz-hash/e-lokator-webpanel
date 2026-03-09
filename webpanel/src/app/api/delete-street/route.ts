import { NextRequest, NextResponse } from "next/server";
import { getAdminApp, getAdminDb } from "../../../lib/server/firebaseAdmin";
import { normalizeStreetId } from "../../../lib/streetUtils";

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return NextResponse.json({ error: "Brak tokenu autoryzacji." }, { status: 401 });

    const adminApp = getAdminApp();
    const decoded = await adminApp.auth().verifyIdToken(token);
    const uid = decoded.uid;
    const db = getAdminDb();

    const body = await req.json();
    const communityId = String(body?.communityId || "").trim();
    const streetId = String(body?.streetId || normalizeStreetId(String(body?.name || ""))).trim();
    const name = String(body?.name || "").trim();
    if (!communityId || !streetId) return NextResponse.json({ error: "Brak communityId lub streetId." }, { status: 400 });

    const userSnap = await db.collection("users").doc(uid).get();
    const userData = userSnap.data() || {};
    const role = String((userData as any).role || "").toUpperCase();
    const userCommunityId = String((userData as any).communityId || (userData as any).customerId || "").trim();
    if (!["MASTER", "ACCOUNTANT"].includes(role)) return NextResponse.json({ error: "Brak uprawnień do usuwania ulic." }, { status: 403 });
    if (userCommunityId && userCommunityId !== communityId) return NextResponse.json({ error: "communityId nie zgadza się z profilem użytkownika." }, { status: 403 });

    await db.doc(`communities/${communityId}/streets/${streetId}`).set({ id: streetId, name: name || streetId, isActive: false, deletedAtMs: Date.now(), updatedAtMs: Date.now(), updatedByUid: uid }, { merge: true });
    return NextResponse.json({ ok: true, streetId });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Błąd usuwania ulicy." }, { status: 500 });
  }
}
