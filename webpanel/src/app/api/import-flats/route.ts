import { NextRequest, NextResponse } from "next/server";
import { getAdminApp, getAdminDb } from "../../../lib/server/firebaseAdmin";
import { buildFlatKey } from "../../../lib/flatMapping";
import { canCreateFlat, getSeatState } from "../../../lib/server/seatLimits";

type Row = {
  street?: string;
  buildingNo?: string;
  apartmentNo?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  email?: string;
  phone?: string;
  areaM2?: number;
};

function splitDisplayName(displayName: string) {
  const parts = String(displayName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] || "", lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) {
      return NextResponse.json({ error: "Brak tokenu autoryzacji." }, { status: 401 });
    }

    const adminApp = getAdminApp();
    const decoded = await adminApp.auth().verifyIdToken(token);
    const uid = decoded.uid;
    const db = getAdminDb();

    const body = await req.json();
    const communityId = String(body?.communityId || "").trim();
    const fallbackStreetId = String(body?.fallbackStreetId || "").trim();
    const fallbackStreetName = String(body?.fallbackStreetName || "").trim();
    const fallbackBuildingNo = String(body?.fallbackBuildingNo || "").trim();
    const rows = Array.isArray(body?.rows) ? (body.rows as Row[]) : [];

    if (!communityId || rows.length === 0) {
      return NextResponse.json({ error: "Brak communityId albo pusty plik." }, { status: 400 });
    }

    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) {
      return NextResponse.json({ error: "Nie znaleziono profilu użytkownika." }, { status: 403 });
    }

    const userData = userSnap.data() || {};
    const role = String((userData as any).role || "").toUpperCase();
    const userCommunityId = String((userData as any).communityId || (userData as any).customerId || "").trim();
    if (!["MASTER", "ACCOUNTANT"].includes(role)) {
      return NextResponse.json({ error: "Brak uprawnień do importu lokali." }, { status: 403 });
    }
    if (userCommunityId && userCommunityId !== communityId) {
      return NextResponse.json({ error: "communityId nie zgadza się z profilem użytkownika." }, { status: 403 });
    }

    const communityRef = db.collection("communities").doc(communityId);
    const [communitySnap, flatsSnap] = await Promise.all([
      communityRef.get(),
      communityRef.collection("flats").get(),
    ]);
    const communityData = communitySnap.data() || {};
    const existingByKey = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
    flatsSnap.docs.forEach((d) => {
      const x: any = d.data();
      const key = String(
        x.flatKey || buildFlatKey(communityId, String(x.street || ""), String(x.buildingNo || ""), String(x.apartmentNo || x.flatNumber || "")),
      );
      existingByKey.set(key, d);
    });

    const streetsSnap = await db.collection("communities").doc(communityId).collection("streets").get();
    const streetIdByName = new Map<string, string>();
    streetsSnap.docs.forEach((d) => {
      const rawName = String((d.data() as any).name || d.id || "").trim();
      if (rawName) streetIdByName.set(rawName.toLowerCase(), d.id);
    });

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let invalid = 0;
    let duplicateInFile = 0;
    const details: string[] = [];
    const now = Date.now();
    const batch = db.batch();
    const seenKeys = new Set<string>();
    let plannedCreates = 0;

    for (const row of rows) {
      const street = String(row.street || fallbackStreetName || "").trim();
      const buildingNo = String(row.buildingNo || fallbackBuildingNo || "").trim();
      const apartmentNo = String(row.apartmentNo || "").trim();

      if (!street || !buildingNo || !apartmentNo) {
        invalid += 1;
        details.push(`Pominięto wiersz bez pełnego adresu: ulica="${street}", budynek="${buildingNo}", lokal="${apartmentNo}".`);
        continue;
      }

      const flatKey = buildFlatKey(communityId, street, buildingNo, apartmentNo);
      if (seenKeys.has(flatKey)) {
        duplicateInFile += 1;
        details.push(`Duplikat w pliku: ${street} ${buildingNo}/${apartmentNo}.`);
        continue;
      }
      seenKeys.add(flatKey);

      let firstName = String(row.firstName || "").trim();
      let lastName = String(row.lastName || "").trim();
      const displayName = String(row.displayName || "").trim();
      if ((!firstName || !lastName) && displayName) {
        const split = splitDisplayName(displayName);
        firstName = firstName || split.firstName;
        lastName = lastName || split.lastName;
      }

      const existing = existingByKey.get(flatKey);
      const existingData: any = existing?.data() || {};
      const newEmail = String(row.email || "").trim();
      const newPhone = String(row.phone || "").trim();
      const newDisplayName = displayName || [firstName, lastName].filter(Boolean).join(" ");

      const nothingNew =
        existing &&
        String(existingData.name || "") === firstName &&
        String(existingData.surname || "") === lastName &&
        String(existingData.displayName || "") === newDisplayName &&
        String(existingData.email || "") === newEmail &&
        String(existingData.phone || "") === newPhone &&
        String(existingData.street || "") === street &&
        String(existingData.buildingNo || "") === buildingNo &&
        String(existingData.apartmentNo || existingData.flatNumber || "") === apartmentNo;

      if (nothingNew) {
        skipped += 1;
        details.push(`Bez zmian: ${street} ${buildingNo}/${apartmentNo}.`);
        continue;
      }

      if (!existing) {
        const seatStateNow = getSeatState({ ...(communityData as any), seatsUsed: Math.max(Number((communityData as any)?.seatsUsed || 0), flatsSnap.size + plannedCreates) }, flatsSnap.size + plannedCreates);
        if (!canCreateFlat(seatStateNow)) {
          invalid += 1;
          details.push(`Brak seats: ${street} ${buildingNo}/${apartmentNo}. Limit: ${seatStateNow.limit}, wykorzystane: ${seatStateNow.used}.`);
          continue;
        }
      }

      const streetId = streetIdByName.get(street.toLowerCase()) || fallbackStreetId || street;
      const flatRef = existing
        ? communityRef.collection("flats").doc(existing.id)
        : communityRef.collection("flats").doc();
      const createdAtMs = Number(existingData.createdAtMs || now);
      const flatLabel = `${street} ${buildingNo}/${apartmentNo}`;

      batch.set(
        flatRef,
        {
          communityId,
          streetId,
          street,
          buildingNo,
          apartmentNo,
          flatNumber: apartmentNo,
          flatLabel,
          flatKey,
          name: firstName || existingData.name || "",
          surname: lastName || existingData.surname || "",
          displayName: newDisplayName || existingData.displayName || "",
          email: newEmail || existingData.email || "",
          phone: newPhone || existingData.phone || "",
          areaM2: row.areaM2 ?? existingData.areaM2 ?? null,
          updatedAtMs: now,
          createdAtMs,
        },
        { merge: true },
      );

      const payerRef = communityRef.collection("payers").doc(flatRef.id);
      batch.set(
        payerRef,
        {
          flatId: flatRef.id,
          streetId,
          street,
          buildingNo,
          apartmentNo,
          flatLabel,
          flatKey,
          name: firstName || existingData.name || "",
          surname: lastName || existingData.surname || "",
          displayName: newDisplayName,
          email: newEmail || String(existingData.email || ""),
          phone: newPhone || String(existingData.phone || ""),
          mailOnly: !!(newEmail || String(existingData.email || "")),
          updatedAtMs: now,
          createdAtMs,
        },
        { merge: true },
      );

      if (existing) {
        updated += 1;
        details.push(`Zaktualizowano: ${street} ${buildingNo}/${apartmentNo}.`);
      } else {
        created += 1;
        plannedCreates += 1;
        details.push(`Utworzono: ${street} ${buildingNo}/${apartmentNo}.`);
      }
    }

    if (plannedCreates > 0) {
      batch.set(communityRef, {
        seatsUsed: Math.max(Number((communityData as any)?.seatsUsed || 0), flatsSnap.size) + plannedCreates,
        updatedAtMs: now,
      }, { merge: true });
    }
    await batch.commit();
    const seatStateEnd = getSeatState({ ...(communityData as any), seatsUsed: Math.max(Number((communityData as any)?.seatsUsed || 0), flatsSnap.size) + plannedCreates }, flatsSnap.size + plannedCreates);
    return NextResponse.json({ ok: true, created, updated, skipped, invalid, duplicateInFile, details, seatLimit: seatStateEnd.limit, seatUsed: seatStateEnd.used, seatRemaining: seatStateEnd.remaining, seatSource: seatStateEnd.source });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Błąd importu serwerowego." }, { status: 500 });
  }
}
