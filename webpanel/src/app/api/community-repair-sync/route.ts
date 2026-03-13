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
function buildFlatKey(communityId: string, street: unknown, buildingNo: unknown, apartmentNo: unknown) {
  return [communityId, street, buildingNo, apartmentNo]
    .map((value) => normStreetName(value).replace(/-/g, ""))
    .filter(Boolean)
    .join("|");
}
function fullName(data: any) {
  return safe(data?.displayName || [safe(data?.name), safe(data?.surname)].filter(Boolean).join(" "));
}

async function getUsersForCommunity(db: FirebaseFirestore.Firestore, communityId: string) {
  const [byCommunity, byCustomer] = await Promise.all([
    db.collection("users").where("communityId", "==", communityId).get(),
    db.collection("users").where("customerId", "==", communityId).get(),
  ]);
  const merged = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  [...byCommunity.docs, ...byCustomer.docs].forEach((doc) => merged.set(doc.id, doc));
  return Array.from(merged.values());
}

async function repairCommunity(db: FirebaseFirestore.Firestore, communityId: string) {
  const [communitySnap, payersSnap, flatsSnap, streetsSnap, assignmentsSnap, userDocs] = await Promise.all([
    db.doc(`communities/${communityId}`).get(),
    db.collection(`communities/${communityId}/payers`).get(),
    db.collection(`communities/${communityId}/flats`).get(),
    db.collection(`communities/${communityId}/streets`).get(),
    db.collection(`communities/${communityId}/streetAssignments`).get(),
    getUsersForCommunity(db, communityId),
  ]);

  const usersByEmail = new Map<string, { id: string; data: any }>();
  const visibleUsers = new Map<string, any>();
  for (const doc of userDocs) {
    const data = doc.data() || {};
    const email = normEmail(data.email);
    const role = safe(data.role).toUpperCase();
    const removed = role === "REMOVED" || data.removedAtMs != null;
    const isSynthetic = doc.id.startsWith(`payer_${communityId}_`) || doc.id.startsWith(`shadow_${communityId}_`) || data.isShadow === true || data.placeholderResident === true;
    if (!removed) visibleUsers.set(doc.id, data);
    if (email && !removed && (data.authLinked === true || !isSynthetic) && !usersByEmail.has(email)) {
      usersByEmail.set(email, { id: doc.id, data });
    }
  }

  const payerFlatIds = new Set<string>();
  let payerCount = 0;
  let linkedUsers = 0;
  let syntheticUpserts = 0;

  for (const payerDoc of payersSnap.docs) {
    payerCount += 1;
    const payer = payerDoc.data() || {};
    const flatId = safe(payer.flatId || payerDoc.id);
    if (flatId) payerFlatIds.add(flatId);
    const street = safe(payer.street);
    const buildingNo = safe(payer.buildingNo);
    const apartmentNo = safe(payer.apartmentNo || payer.flatNumber);
    const flatLabel = safe(payer.flatLabel || [street, buildingNo].filter(Boolean).join(" ") + (apartmentNo ? `/${apartmentNo}` : ""));
    const flatKey = safe(payer.flatKey || buildFlatKey(communityId, street, buildingNo, apartmentNo));
    const linked = usersByEmail.get(normEmail(payer.email));
    const residentUid = safe(payer.residentUid || payer.userId || linked?.id);

    if (linked?.id) {
      const patch = {
        residentUid: linked.id,
        userId: linked.id,
        flatId,
        communityId,
        customerId: communityId,
        street,
        streetId: safe(linked.data.streetId || payer.streetId || normStreetName(street)),
        buildingNo,
        apartmentNo,
        flatLabel,
        flatKey,
        authLinked: true,
        appVisible: true,
        placeholderResident: false,
        isShadow: false,
        source: safe(linked.data.source || "WEBPANEL_PAYER"),
        updatedAtMs: Date.now(),
      };
      await Promise.all([
        db.doc(`communities/${communityId}/payers/${payerDoc.id}`).set({ ...patch, mailOnly: false }, { merge: true }),
        db.doc(`communities/${communityId}/flats/${flatId}`).set({ ...patch, email: safe(linked.data.email || payer.email), phone: safe(linked.data.phone || payer.phone) }, { merge: true }),
        db.doc(`users/${linked.id}`).set({
          ...patch,
          role: safe(linked.data.role || "RESIDENT") || "RESIDENT",
          displayName: safe(linked.data.displayName || fullName(payer)),
          firstName: safe(linked.data.firstName || payer.name) || undefined,
          lastName: safe(linked.data.lastName || payer.surname) || undefined,
          email: safe(linked.data.email || payer.email),
          emailLower: normEmail(linked.data.email || payer.email),
          phone: safe(linked.data.phone || payer.phone),
          active: true,
        }, { merge: true }),
      ]);
      const syntheticRef = db.doc(`users/${shadowUserId(communityId, flatId)}`);
      const syntheticSnap = await syntheticRef.get();
      if (syntheticSnap.exists && syntheticSnap.id !== linked.id) await syntheticRef.delete().catch(() => null);
      linkedUsers += 1;
      continue;
    }

    const syntheticUid = residentUid || shadowUserId(communityId, flatId);
    await Promise.all([
      db.doc(`users/${syntheticUid}`).set({
        uid: syntheticUid,
        communityId,
        customerId: communityId,
        flatId,
        role: "RESIDENT",
        displayName: fullName(payer) || flatLabel || apartmentNo,
        firstName: safe(payer.name) || undefined,
        lastName: safe(payer.surname) || undefined,
        name: safe(payer.name),
        surname: safe(payer.surname),
        email: safe(payer.email),
        emailLower: normEmail(payer.email),
        phone: safe(payer.phone),
        street,
        streetId: safe(payer.streetId || normStreetName(street)),
        buildingNo,
        apartmentNo,
        flatLabel,
        flatKey,
        mailOnly: !!safe(payer.email) && !safe(payer.phone),
        placeholderResident: false,
        isShadow: false,
        authLinked: false,
        active: true,
        appVisible: true,
        source: "WEBPANEL_PAYER",
        createdAtMs: Number(payer.createdAtMs || Date.now()),
        updatedAtMs: Date.now(),
      }, { merge: true }),
      db.doc(`communities/${communityId}/payers/${payerDoc.id}`).set({ residentUid: syntheticUid, userId: syntheticUid, appVisible: true, flatId, flatLabel, flatKey, updatedAtMs: Date.now() }, { merge: true }),
      db.doc(`communities/${communityId}/flats/${flatId}`).set({ residentUid: syntheticUid, userId: syntheticUid, appVisible: true, flatId, flatLabel, flatKey, updatedAtMs: Date.now() }, { merge: true }),
    ]);
    syntheticUpserts += 1;
  }

  const streetMap = new Map<string, { id: string; name: string }>();
  const registerStreet = (idValue: unknown, nameValue: unknown) => {
    const name = safe(nameValue);
    const id = safe(idValue || normStreetName(name));
    if (id && name) streetMap.set(id, { id, name });
  };

  for (const doc of streetsSnap.docs) {
    const data = doc.data() || {};
    if (data.isActive === false || data.deletedAtMs != null) continue;
    registerStreet(data.id || doc.id, data.name || data.street || doc.id);
  }
  for (const doc of assignmentsSnap.docs) {
    const data = doc.data() || {};
    registerStreet(data.streetId || data.id || doc.id, data.streetName || data.name || data.street || doc.id);
  }
  for (const doc of flatsSnap.docs) {
    const data = doc.data() || {};
    registerStreet(data.streetId, data.street);
  }
  for (const doc of payersSnap.docs) {
    const data = doc.data() || {};
    registerStreet(data.streetId, data.street);
  }
  const communityData = (communitySnap.data() || {}) as any;
  const streetIds = Array.isArray(communityData.streetIds) ? communityData.streetIds : [];
  const streetNames = Array.isArray(communityData.streetNames) ? communityData.streetNames : [];
  const streetsList = Array.isArray(communityData.streetsList) ? communityData.streetsList : [];
  streetIds.forEach((id: unknown, idx: number) => registerStreet(id, streetNames[idx]));
  streetsList.forEach((item: any) => registerStreet(item?.id, item?.name));

  const visibleResidents = Array.from(visibleUsers.values()).filter((data: any) => {
    const role = safe(data.role).toUpperCase();
    return ["RESIDENT", "CONTRACTOR"].includes(role) && data.appVisible !== false && data.removedAtMs == null;
  });

  const appSeatsUsed = visibleResidents.length;
  const panelSeatsUsed = payerCount;
  const occupiedSeats = Math.max(payerFlatIds.size, appSeatsUsed, panelSeatsUsed);

  await db.doc(`communities/${communityId}`).set({
    streetIds: Array.from(streetMap.values()).map((item) => item.id),
    streetNames: Array.from(streetMap.values()).map((item) => item.name),
    streetsList: Array.from(streetMap.values()),
    seatsUsed: occupiedSeats,
    appSeatsUsed,
    panelSeatsUsed,
    residentCount: appSeatsUsed,
    usersCount: appSeatsUsed,
    occupiedSeats,
    updatedAtMs: Date.now(),
  }, { merge: true });

  return {
    payerCount,
    linkedUsers,
    syntheticUpserts,
    streetCount: streetMap.size,
    appSeatsUsed,
    panelSeatsUsed,
    occupiedSeats,
  };
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
    const role = safe((me as any).role).toUpperCase();
    if (!["MASTER", "ACCOUNTANT", "ADMIN"].includes(role)) return NextResponse.json({ error: "Brak uprawnień." }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const communityId = safe((body as any)?.communityId || (me as any).communityId || (me as any).customerId);
    if (!communityId) return NextResponse.json({ error: "Brak communityId." }, { status: 400 });

    const result = await repairCommunity(db, communityId);
    return NextResponse.json({ ok: true, ...result });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Błąd synchronizacji wspólnoty." }, { status: 500 });
  }
}
