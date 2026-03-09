import { NextRequest, NextResponse } from "next/server";
import { getAdminApp, getAdminDb } from "../../../lib/server/firebaseAdmin";
import { ensureStreet } from "../../../lib/server/streetRegistry";

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
    const name = String(body?.name || "").trim();
    if (!communityId || !name) return NextResponse.json({ error: "Brak communityId lub nazwy ulicy." }, { status: 400 });

    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) return NextResponse.json({ error: "Nie znaleziono profilu użytkownika." }, { status: 403 });
    const userData = userSnap.data() || {};
    const role = String((userData as any).role || "").toUpperCase();
    const userCommunityId = String((userData as any).communityId || (userData as any).customerId || "").trim();
    if (!["MASTER", "ACCOUNTANT"].includes(role)) return NextResponse.json({ error: "Brak uprawnień do zapisu ulic." }, { status: 403 });
    if (userCommunityId && userCommunityId !== communityId) return NextResponse.json({ error: "communityId nie zgadza się z profilem użytkownika." }, { status: 403 });

    const street = await ensureStreet(db as any, communityId, name, uid);
    if (!street?.id) return NextResponse.json({ error: "Nie udało się zapisać ulicy." }, { status: 400 });
    await db.doc(`communities/${communityId}/streets/${street.id}`).set({ deletedAtMs: null, isActive: true, updatedAtMs: Date.now() }, { merge: true });
    return NextResponse.json({ ok: true, street });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Błąd zapisu ulicy." }, { status: 500 });
  }
}
