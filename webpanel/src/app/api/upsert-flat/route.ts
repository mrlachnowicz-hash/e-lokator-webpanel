import { NextRequest, NextResponse } from 'next/server';
import { getAdminApp, getAdminDb } from '../../../lib/server/firebaseAdmin';
import { buildFlatKey } from '../../../lib/flatMapping';
import { canCreateFlat, getSeatState } from '../../../lib/server/seatLimits';

function splitDisplayName(displayName: string) {
  const parts = String(displayName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] || '', lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return NextResponse.json({ error: 'Brak tokenu autoryzacji.' }, { status: 401 });

    const adminApp = getAdminApp();
    const decoded = await adminApp.auth().verifyIdToken(token);
    const uid = decoded.uid;
    const db = getAdminDb();

    const body = await req.json();
    const communityId = String(body?.communityId || '').trim();
    const flatId = String(body?.id || '').trim();
    const street = String(body?.street || '').trim();
    const buildingNo = String(body?.buildingNo || '').trim();
    const apartmentNo = String(body?.apartmentNo || '').trim();
    let firstName = String(body?.name || body?.firstName || '').trim();
    let lastName = String(body?.surname || body?.lastName || '').trim();
    const displayNameRaw = String(body?.displayName || '').trim();
    const email = String(body?.email || '').trim();
    const phone = String(body?.phone || '').trim();

    if (!communityId || !street || !buildingNo || !apartmentNo) {
      return NextResponse.json({ error: 'Brakuje wymaganych danych lokalu.' }, { status: 400 });
    }

    if ((!firstName || !lastName) && displayNameRaw) {
      const split = splitDisplayName(displayNameRaw);
      firstName = firstName || split.firstName;
      lastName = lastName || split.lastName;
    }

    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return NextResponse.json({ error: 'Nie znaleziono profilu użytkownika.' }, { status: 403 });
    const userData = userSnap.data() || {};
    const role = String((userData as any).role || '').toUpperCase();
    const userCommunityId = String((userData as any).communityId || (userData as any).customerId || '').trim();
    if (!['MASTER', 'ACCOUNTANT'].includes(role)) {
      return NextResponse.json({ error: 'Brak uprawnień do zapisu lokalu.' }, { status: 403 });
    }
    if (userCommunityId && userCommunityId !== communityId) {
      return NextResponse.json({ error: 'communityId nie zgadza się z profilem użytkownika.' }, { status: 403 });
    }

    const communityRef = db.collection('communities').doc(communityId);
    const flatsCol = communityRef.collection('flats');
    const flatKey = buildFlatKey(communityId, street, buildingNo, apartmentNo);
    const flatsSnap = await flatsCol.get();
    const existing = flatsSnap.docs.find((d) => {
      if (flatId && d.id === flatId) return true;
      const x: any = d.data();
      const key = String(x.flatKey || buildFlatKey(communityId, String(x.street || ''), String(x.buildingNo || ''), String(x.apartmentNo || x.flatNumber || '')));
      return key === flatKey;
    });

    const ref = existing ? flatsCol.doc(existing.id) : (flatId ? flatsCol.doc(flatId) : flatsCol.doc());
    const payerRef = communityRef.collection('payers').doc(ref.id);
    const now = Date.now();
    const result = await db.runTransaction(async (tx) => {
      const [communitySnap, currentFlatSnap, currentPayerSnap] = await Promise.all([
        tx.get(communityRef),
        tx.get(ref),
        tx.get(payerRef),
      ]);
      const communityData = communitySnap.data() || {};
      const alreadyExists = currentFlatSnap.exists;
      const currentFlat: any = currentFlatSnap.data() || {};
      const seatState = getSeatState(communityData as any, flatsSnap.size);
      if (!alreadyExists && !canCreateFlat(seatState)) {
        throw new Error(`Brak wolnych seats. Limit: ${seatState.limit}, wykorzystane: ${seatState.used}.`);
      }

      const flatLabel = `${street} ${buildingNo}/${apartmentNo}`;
      const mergedDisplayName = displayNameRaw || [firstName, lastName].filter(Boolean).join(' ');
      const createdAtMs = Number(currentFlat.createdAtMs || now);

      tx.set(ref, {
        communityId,
        street,
        buildingNo,
        apartmentNo,
        flatNumber: apartmentNo,
        flatLabel,
        flatKey,
        name: firstName || currentFlat.name || '',
        surname: lastName || currentFlat.surname || '',
        residentName: [firstName || currentFlat.name || '', lastName || currentFlat.surname || ''].filter(Boolean).join(' '),
        displayName: mergedDisplayName || currentFlat.displayName || '',
        email: email || currentFlat.email || '',
        phone: phone || currentFlat.phone || '',
        createdAtMs,
        updatedAtMs: now,
      }, { merge: true });

      tx.set(payerRef, {
        flatId: ref.id,
        communityId,
        street,
        buildingNo,
        apartmentNo,
        flatNumber: apartmentNo,
        flatLabel,
        flatKey,
        name: firstName || currentFlat.name || '',
        surname: lastName || currentFlat.surname || '',
        displayName: mergedDisplayName || currentFlat.displayName || '',
        email: email || currentFlat.email || '',
        phone: phone || currentFlat.phone || '',
        mailOnly: !currentFlat.residentUid && !!(email || currentFlat.email),
        createdAtMs: Number((currentPayerSnap.data() as any)?.createdAtMs || createdAtMs),
        updatedAtMs: now,
      }, { merge: true });

      if (!alreadyExists) {
        const nextUsed = Math.max(seatState.used + 1, Number(communityData.seatsUsed || 0) + 1);
        tx.set(communityRef, {
          seatsUsed: nextUsed,
          updatedAtMs: now,
        }, { merge: true });
      }

      return {
        created: !alreadyExists,
        seatLimit: seatState.limit,
        seatUsed: !alreadyExists ? seatState.used + 1 : seatState.used,
        seatRemaining: seatState.limit == null ? null : seatState.limit - (!alreadyExists ? seatState.used + 1 : seatState.used),
      };
    });

    return NextResponse.json({
      ok: true,
      created: result.created,
      id: ref.id,
      message: result.created ? 'Dodano nowy lokal.' : 'Zaktualizowano istniejący lokal.',
      seatLimit: result.seatLimit,
      seatUsed: result.seatUsed,
      seatRemaining: result.seatRemaining,
    });
  } catch (error: any) {
    const message = error?.message || 'Błąd zapisu lokalu.';
    const status = /Brak wolnych seats/i.test(message) ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
