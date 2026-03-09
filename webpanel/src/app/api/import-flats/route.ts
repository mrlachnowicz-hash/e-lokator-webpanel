import { NextRequest, NextResponse } from "next/server";
import { getAdminApp, getAdminDb } from "../../../lib/server/firebaseAdmin";
import { buildFlatKey, buildFlatLabel } from "../../../lib/flatMapping";
import { canCreateFlat, getSeatState, getSeatUsed } from "../../../lib/server/seatLimits";
import { ensureStreet } from "../../../lib/server/streetRegistry";

type Row = {
  street?: string;
  buildingNo?: string;
  apartmentNo?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  email?: string;
  phone?: string;
  areaM2?: number | string;
};

function splitDisplayName(displayName: string) {
  const parts = String(displayName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] || "", lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function parseAreaM2(value: unknown) {
  const raw = clean(value).replace(",", ".");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

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
    const communityId = clean(body?.communityId);
    const fallbackStreetId = clean(body?.fallbackStreetId);
    const fallbackStreetName = clean(body?.fallbackStreetName);
    const fallbackBuildingNo = clean(body?.fallbackBuildingNo);
    const rows = Array.isArray(body?.rows) ? (body.rows as Row[]) : [];
    if (!communityId || rows.length === 0) return NextResponse.json({ error: "Brak communityId albo pusty plik." }, { status: 400 });

    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) return NextResponse.json({ error: "Nie znaleziono profilu użytkownika." }, { status: 403 });
    const userData = userSnap.data() || {};
    const role = clean((userData as any).role).toUpperCase();
    const userCommunityId = clean((userData as any).communityId || (userData as any).customerId);
    if (!["MASTER", "ACCOUNTANT"].includes(role)) return NextResponse.json({ error: "Brak uprawnień do importu lokali." }, { status: 403 });
    if (userCommunityId && userCommunityId !== communityId) return NextResponse.json({ error: "communityId nie zgadza się z profilem użytkownika." }, { status: 403 });

    const communityRef = db.collection("communities").doc(communityId);
    const [communitySnap, flatsSnap, streetsSnap] = await Promise.all([
      communityRef.get(),
      communityRef.collection("flats").get(),
      communityRef.collection("streets").get(),
    ]);
    const communityData = communitySnap.data() || {};

    const existingByKey = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
    flatsSnap.docs.forEach((d) => {
      const data: any = d.data();
      const key = String(data.flatKey || buildFlatKey(communityId, data.street || "", data.buildingNo || "", data.apartmentNo || data.flatNumber || ""));
      if (key) existingByKey.set(key, d);
    });

    const streetIdByName = new Map<string, string>();
    streetsSnap.docs.forEach((d) => {
      const rawName = clean((d.data() as any).name || d.id);
      if (rawName) streetIdByName.set(rawName.toLowerCase(), d.id);
    });

    const now = Date.now();
    const batch = db.batch();
    const details: string[] = [];
    const seenKeys = new Set<string>();
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let invalid = 0;
    let duplicateInFile = 0;
    let conflicts = 0;
    let plannedCreates = 0;

    const uniqueCreates = new Set<string>();
    for (const raw of rows) {
      const street = clean(raw.street || fallbackStreetName);
      const buildingNo = clean(raw.buildingNo || fallbackBuildingNo);
      const apartmentNo = clean(raw.apartmentNo);
      if (!street || !buildingNo || !apartmentNo) continue;
      const flatKey = buildFlatKey(communityId, street, buildingNo, apartmentNo);
      if (seenKeys.has(flatKey)) continue;
      seenKeys.add(flatKey);
      if (!existingByKey.has(flatKey)) uniqueCreates.add(flatKey);
    }
    seenKeys.clear();

    const usedBefore = Math.max(getSeatUsed(communityData as any, flatsSnap.size), flatsSnap.size);
    const seatStateBefore = getSeatState({ ...(communityData as any), seatsUsed: usedBefore }, usedBefore);
    if (seatStateBefore.limit != null && usedBefore + uniqueCreates.size > seatStateBefore.limit) {
      return NextResponse.json({
        error: `Brak dostępnej ilości miejsc. Limit: ${seatStateBefore.limit}, wykorzystane: ${usedBefore}, próba importu nowych lokali: ${uniqueCreates.size}.`,
        seatLimit: seatStateBefore.limit,
        seatUsed: usedBefore,
        seatRemaining: Math.max(0, (seatStateBefore.limit ?? 0) - usedBefore),
      }, { status: 409 });
    }

    for (const raw of rows) {
      const street = clean(raw.street || fallbackStreetName);
      const buildingNo = clean(raw.buildingNo || fallbackBuildingNo);
      const apartmentNo = clean(raw.apartmentNo);
      if (!street || !buildingNo || !apartmentNo) {
        invalid += 1;
        details.push(`Pominięto rekord bez pełnego adresu: ulica="${street}", budynek="${buildingNo}", lokal="${apartmentNo}".`);
        continue;
      }

      const flatKey = buildFlatKey(communityId, street, buildingNo, apartmentNo);
      if (seenKeys.has(flatKey)) {
        duplicateInFile += 1;
        details.push(`Duplikat w pliku: ${street} ${buildingNo}/${apartmentNo}.`);
        continue;
      }
      seenKeys.add(flatKey);
      await ensureStreet(db as any, communityId, street, uid);

      let firstName = clean(raw.firstName);
      let lastName = clean(raw.lastName);
      const displayName = clean(raw.displayName);
      if ((!firstName || !lastName) && displayName) {
        const split = splitDisplayName(displayName);
        firstName = firstName || split.firstName;
        lastName = lastName || split.lastName;
      }
      const email = clean(raw.email);
      const phone = clean(raw.phone);
      const areaM2 = parseAreaM2(raw.areaM2);

      const existing = existingByKey.get(flatKey);
      const existingData: any = existing?.data() || {};
      const mergedDisplayName = displayName || [firstName, lastName].filter(Boolean).join(" ") || existingData.displayName || "";
      const streetId = streetIdByName.get(street.toLowerCase()) || fallbackStreetId || existingData.streetId || street;
      const flatLabel = buildFlatLabel(street, buildingNo, apartmentNo);

      const nextPayload = {
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
        displayName: mergedDisplayName,
        residentName: mergedDisplayName,
        email: email || existingData.email || "",
        phone: phone || existingData.phone || "",
        areaM2: areaM2 ?? existingData.areaM2 ?? null,
        updatedAtMs: now,
        createdAtMs: Number(existingData.createdAtMs || now),
      };

      const isSame = existing && [
        nextPayload.street,
        nextPayload.buildingNo,
        nextPayload.apartmentNo,
        nextPayload.name,
        nextPayload.surname,
        nextPayload.displayName,
        nextPayload.email,
        nextPayload.phone,
        String(nextPayload.areaM2 ?? ""),
      ].join("|") === [
        clean(existingData.street),
        clean(existingData.buildingNo),
        clean(existingData.apartmentNo || existingData.flatNumber),
        clean(existingData.name),
        clean(existingData.surname),
        clean(existingData.displayName),
        clean(existingData.email),
        clean(existingData.phone),
        String(existingData.areaM2 ?? ""),
      ].join("|");

      if (isSame) {
        skipped += 1;
        details.push(`Pominięto bez zmian: ${flatLabel}.`);
        continue;
      }

      if (!existing) {
        const seatStateNow = getSeatState({ ...(communityData as any), seatsUsed: usedBefore + plannedCreates }, usedBefore + plannedCreates);
        if (!canCreateFlat(seatStateNow)) {
          invalid += 1;
          details.push(`Brak miejsc seats dla lokalu ${flatLabel}.`);
          continue;
        }
      }

      if (existing && (email || phone || mergedDisplayName) && (clean(existingData.email) !== email || clean(existingData.phone) !== phone || clean(existingData.displayName) !== mergedDisplayName)) {
        conflicts += 1;
      }

      const flatRef = existing ? communityRef.collection("flats").doc(existing.id) : communityRef.collection("flats").doc();
      batch.set(flatRef, nextPayload, { merge: true });
      batch.set(communityRef.collection("payers").doc(flatRef.id), {
        flatId: flatRef.id,
        flatKey,
        flatLabel,
        streetId,
        street,
        buildingNo,
        apartmentNo,
        name: nextPayload.name,
        surname: nextPayload.surname,
        displayName: mergedDisplayName,
        residentName: mergedDisplayName,
        email: nextPayload.email,
        phone: nextPayload.phone,
        areaM2: nextPayload.areaM2,
        mailOnly: !!nextPayload.email,
        updatedAtMs: now,
        createdAtMs: Number(existingData.createdAtMs || now),
      }, { merge: true });

      if (existing) {
        updated += 1;
        details.push(`Zaktualizowano: ${flatLabel}.`);
      } else {
        created += 1;
        plannedCreates += 1;
        details.push(`Utworzono: ${flatLabel}.`);
      }
    }

    await batch.commit();
    if (plannedCreates > 0) {
      await communityRef.set({ seatsUsed: usedBefore + plannedCreates, updatedAtMs: now }, { merge: true });
    }

    return NextResponse.json({ ok: true, created, updated, skipped, invalid, duplicateInFile, conflicts, details });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Import flats error" }, { status: 500 });
  }
}
