import { NextRequest, NextResponse } from "next/server";
import { getAdminApp, getAdminDb } from "@/lib/server/firebaseAdmin";

function safe(value: unknown) { return String(value || "").trim(); }
function normEmail(value: unknown) { return safe(value).toLowerCase(); }
function normStreetName(value: unknown) {
  return safe(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function shadowUserId(communityId: string, flatId: string) {
  return `payer_${communityId}_${flatId}`;
}
function legacyShadowUserId(communityId: string, flatId: string) {
  return `shadow_${communityId}_${flatId}`;
}

async function repairCommunity(db: FirebaseFirestore.Firestore, communityId: string) {
  const [payersSnap, streetsSnap, assignmentsSnap, usersSnap] = await Promise.all([
    db.collection(`communities/${communityId}/payers`).get(),
    db.collection(`communities/${communityId}/streets`).get(),
    db.collection(`communities/${communityId}/streetAssignments`).get(),
    db.collection("users").where("communityId", "==", communityId).get(),
  ]);

  const usersByEmail = new Map<string, { id: string; data: any }>();
  usersSnap.docs.forEach((doc) => {
    const data = doc.data() || {};
    const email = normEmail(data.email);
    const role = safe(data.role).toUpperCase();
    if (email && data.isShadow !== true && data.placeholderResident !== true && role != "REMOVED" && !usersByEmail.has(email)) usersByEmail.set(email, { id: doc.id, data });
  });

  let payerCount = 0;
  let shadowCreated = 0;
  let payerLinked = 0;

  for (const payerDoc of payersSnap.docs) {
    payerCount += 1;
    const payer = payerDoc.data() || {};
    const flatId = safe(payer.flatId || payerDoc.id);
    const email = normEmail(payer.email);
    const linked = email ? usersByEmail.get(email) : null;
    const residentUid = safe(payer.residentUid || payer.userId || linked?.id);

    if (linked?.id) {
      const patch = {
        residentUid: linked.id,
        userId: linked.id,
        mailOnly: false,
        updatedAtMs: Date.now(),
      };
      await Promise.all([
        db.doc(`communities/${communityId}/payers/${payerDoc.id}`).set(patch, { merge: true }),
        db.doc(`communities/${communityId}/flats/${flatId}`).set({ ...patch, email: safe(linked.data.email || payer.email), phone: safe(linked.data.phone || payer.phone) }, { merge: true }),
        db.doc(`users/${linked.id}`).set({
          flatId,
          communityId,
          role: safe(linked.data.role || "RESIDENT") || "RESIDENT",
          street: safe(linked.data.street || payer.street),
          streetId: safe(linked.data.streetId || payer.streetId),
          buildingNo: safe(linked.data.buildingNo || payer.buildingNo),
          apartmentNo: safe(linked.data.apartmentNo || payer.apartmentNo || payer.flatNumber),
          flatLabel: safe(linked.data.flatLabel || payer.flatLabel),
          updatedAtMs: Date.now(),
        }, { merge: true }),
      ]);
      const shadowRef = db.doc(`users/${shadowUserId(communityId, flatId)}`);
      const shadowSnap = await shadowRef.get();
      if (shadowSnap.exists && (shadowSnap.data()?.placeholderResident === true || shadowSnap.data()?.isShadow === true)) await shadowRef.delete().catch(() => null);
      const legacyShadowRef = db.doc(`users/${legacyShadowUserId(communityId, flatId)}`);
      const legacyShadowSnap = await legacyShadowRef.get();
      if (legacyShadowSnap.exists) await legacyShadowRef.delete().catch(() => null);
      payerLinked += 1;
      continue;
    }

    const placeholderUid = shadowUserId(communityId, flatId);
    const shadowRef = db.doc(`users/${placeholderUid}`);
    const shadowSnap = await shadowRef.get();
    if (!residentUid) {
      const placeholderPatch = {
        uid: placeholderUid,
        communityId,
        customerId: communityId,
        flatId,
        role: "RESIDENT",
        displayName: safe(payer.displayName || `${payer.name || ""} ${payer.surname || ""}`),
        firstName: safe(payer.name),
        lastName: safe(payer.surname),
        name: safe(payer.name),
        surname: safe(payer.surname),
        email: safe(payer.email),
        emailLower: normEmail(payer.email),
        phone: safe(payer.phone),
        street: safe(payer.street),
        streetId: safe(payer.streetId),
        buildingNo: safe(payer.buildingNo),
        apartmentNo: safe(payer.apartmentNo || payer.flatNumber),
        flatLabel: safe(payer.flatLabel),
        flatKey: safe(payer.flatKey),
        mailOnly: false,
        placeholderResident: true,
        isShadow: true,
        authLinked: false,
        active: false,
        appVisible: false,
        source: "WEBPANEL_PLACEHOLDER",
        createdAtMs: Number(payer.createdAtMs || Date.now()),
        updatedAtMs: Date.now(),
      };
      await Promise.all([
        shadowRef.set(placeholderPatch, { merge: true }),
        db.doc(`communities/${communityId}/payers/${payerDoc.id}`).set({ residentUid: placeholderUid, userId: placeholderUid, appVisible: true, updatedAtMs: Date.now() }, { merge: true }),
        db.doc(`communities/${communityId}/flats/${flatId}`).set({ residentUid: placeholderUid, userId: placeholderUid, appVisible: true, updatedAtMs: Date.now() }, { merge: true }),
      ]);
      shadowCreated += shadowSnap.exists ? 0 : 1;
      const legacyShadowRef = db.doc(`users/${legacyShadowUserId(communityId, flatId)}`);
      const legacyShadowSnap = await legacyShadowRef.get();
      if (legacyShadowSnap.exists) await legacyShadowRef.delete().catch(() => null);
    }
  }

  const streetMap = new Map<string, { id: string; name: string }>();
  for (const doc of streetsSnap.docs) {
    const data = doc.data() || {};
    const id = safe(doc.id || data.id || normStreetName(data.name || data.street));
    const name = safe(data.name || data.street || doc.id);
    if (id && name) streetMap.set(id, { id, name });
  }
  for (const doc of assignmentsSnap.docs) {
    const data = doc.data() || {};
    const name = safe(data.name || data.street || doc.id);
    const id = safe(data.id || normStreetName(name) || doc.id);
    if (id && name && !streetMap.has(id)) streetMap.set(id, { id, name });
  }

  for (const item of streetMap.values()) {
    await Promise.all([
      db.doc(`communities/${communityId}/streets/${item.id}`).set({ id: item.id, communityId, name: item.name, normalizedName: item.id, isActive: true, updatedAtMs: Date.now() }, { merge: true }),
      db.doc(`communities/${communityId}/streetAssignments/${item.id}`).set({ id: item.id, communityId, name: item.name, street: item.name, isActive: true, updatedAtMs: Date.now() }, { merge: true }),
    ]);
  }

  await db.doc(`communities/${communityId}`).set({
    seatsUsed: Math.max(payerCount, usersSnap.size),
    panelSeatsUsed: payerCount,
    appSeatsUsed: usersSnap.size,
    residentCount: Math.max(payerCount, usersSnap.size),
    usersCount: usersSnap.size,
    occupiedSeats: Math.max(payerCount, usersSnap.size),
    streetIds: Array.from(streetMap.values()).map((item) => item.id),
    streetNames: Array.from(streetMap.values()).map((item) => item.name),
    streetsList: Array.from(streetMap.values()),
    updatedAtMs: Date.now(),
  }, { merge: true });

  return { payerCount, shadowCreated, payerLinked, streetCount: streetMap.size };
}

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
    if (!["MASTER", "ACCOUNTANT", "ADMIN"].includes(role)) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const communityId = safe(body?.communityId || me.communityId || me.customerId);
    if (!communityId) return NextResponse.json({ error: "Brak communityId." }, { status: 400 });

    const result = await repairCommunity(db, communityId);
    return NextResponse.json({ ok: true, ...result });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Błąd synchronizacji wspólnoty." }, { status: 500 });
  }
}
