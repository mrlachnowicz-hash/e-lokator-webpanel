import { NextRequest, NextResponse } from 'next/server';
import { getAdminApp, getAdminDb } from '../../../lib/server/firebaseAdmin';
import { buildFlatKey } from '../../../lib/flatMapping';
import { canCreateFlat, getSeatState } from '../../../lib/server/seatLimits';
import { ensureStreetExists } from '../../../lib/server/streetRegistry';

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
    const [communitySnap, flatsSnap] = await Promise.all([
      communityRef.get(),
      communityRef.collection('flats').get(),
    ]);
    const communityData = communitySnap.data() || {};

    const flatKey = buildFlatKey(communityId, street, buildingNo, apartmentNo);
    const existing = flatsSnap.docs.find((d) => {
      if (flatId && d.id === flatId) return true;
      const x: any = d.data();
      const key = String(x.flatKey || buildFlatKey(communityId, String(x.street || ''), String(x.buildingNo || ''), String(x.apartmentNo || x.flatNumber || '')));
      return key === flatKey;
    });

    const seatState = getSeatState(communityData as any, flatsSnap.size);
    if (!existing && !canCreateFlat(seatState)) {
      return NextResponse.json({
        error: `Brak wolnych seats. Limit: ${seatState.limit}, wykorzystane: ${seatState.used}.`,
        seatLimit: seatState.limit,
        seatUsed: seatState.used,
        seatRemaining: seatState.remaining,
      }, { status: 409 });
    }

    const now = Date.now();
    const existingData: any = existing?.data() || {};
    const ref = existing ? communityRef.collection('flats').doc(existing.id) : communityRef.collection('flats').doc();
    const flatLabel = `${street} ${buildingNo}/${apartmentNo}`;
    const mergedDisplayName = displayNameRaw || [firstName, lastName].filter(Boolean).join(' ');
    const streetId = (await ensureStreetExists(communityId, street, uid)) || street;

    await ref.set({
      communityId,
      streetId,
      street,
      buildingNo,
      apartmentNo,
      flatNumber: apartmentNo,
      flatLabel,
      flatKey,
      name: firstName || existingData.name || '',
      surname: lastName || existingData.surname || '',
      residentName: [firstName || existingData.name || '', lastName || existingData.surname || ''].filter(Boolean).join(' '),
      displayName: mergedDisplayName || existingData.displayName || '',
      email: email || existingData.email || '',
      phone: phone || existingData.phone || '',
      createdAtMs: Number(existingData.createdAtMs || now),
      updatedAtMs: now,
    }, { merge: true });

    await communityRef.collection('payers').doc(ref.id).set({
      flatId: ref.id,
      streetId,
      street,
      buildingNo,
      apartmentNo,
      flatNumber: apartmentNo,
      flatLabel,
      flatKey,
      name: firstName || existingData.name || '',
      surname: lastName || existingData.surname || '',
      displayName: mergedDisplayName || existingData.displayName || '',
      email: email || existingData.email || '',
      phone: phone || existingData.phone || '',
      mailOnly: !existingData.residentUid && !!(email || existingData.email),
      createdAtMs: Number(existingData.createdAtMs || now),
      updatedAtMs: now,
    }, { merge: true });

    const usedAfter = existing ? flatsSnap.size : flatsSnap.size + 1;
    await communityRef.set({ seatsUsed: usedAfter, updatedAtMs: now }, { merge: true });
    const stateAfter = getSeatState({ ...communityData, seatsUsed: usedAfter } as any, usedAfter);

    return NextResponse.json({
      ok: true,
      created: !existing,
      id: ref.id,
      message: existing ? 'Zaktualizowano istniejący lokal.' : 'Dodano nowy lokal.',
      seatLimit: stateAfter.limit,
      seatUsed: stateAfter.used,
      seatRemaining: stateAfter.remaining,
      seatSource: stateAfter.source,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Błąd zapisu lokalu.' }, { status: 500 });
  }
}
