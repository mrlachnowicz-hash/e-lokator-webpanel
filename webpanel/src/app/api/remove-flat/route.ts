export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const [{ getAdminApp, getAdminDb }, { getSeatUsed }, adminModule] = await Promise.all([
      import('../../../lib/server/firebaseAdmin'),
      import('../../../lib/server/seatLimits'),
      import('firebase-admin'),
    ]);

    const FieldValue = adminModule.firestore.FieldValue;

    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return NextResponse.json({ error: 'Brak tokenu autoryzacji.' }, { status: 401 });

    const adminApp = getAdminApp();
    const decoded = await adminApp.auth().verifyIdToken(token);
    const uid = decoded.uid;
    const db = getAdminDb();

    const body = await req.json();
    const communityId = String(body?.communityId || '').trim();
    const flatId = String(body?.flatId || '').trim();
    if (!communityId || !flatId) {
      return NextResponse.json({ error: 'Brak communityId lub flatId.' }, { status: 400 });
    }

    const userSnap = await db.collection('users').doc(uid).get();
    const userData = userSnap.data() || {};
    const role = String((userData as any).role || '').toUpperCase();
    const userCommunityId = String((userData as any).communityId || (userData as any).customerId || '').trim();
    if (!['MASTER', 'ACCOUNTANT'].includes(role)) {
      return NextResponse.json({ error: 'Brak uprawnień do usunięcia lokalu.' }, { status: 403 });
    }
    if (userCommunityId && userCommunityId !== communityId) {
      return NextResponse.json({ error: 'communityId nie zgadza się z profilem użytkownika.' }, { status: 403 });
    }

    const communityRef = db.collection('communities').doc(communityId);
    const flatRef = communityRef.collection('flats').doc(flatId);
    const payerRef = communityRef.collection('payers').doc(flatId);
    const [communitySnap, flatSnap, linkedUsers] = await Promise.all([
      communityRef.get(),
      flatRef.get(),
      db.collection('users').where('communityId', '==', communityId).where('flatId', '==', flatId).get(),
    ]);

    if (!flatSnap.exists) {
      return NextResponse.json({ error: 'Lokal nie istnieje.' }, { status: 404 });
    }

    const batch = db.batch();
    batch.delete(flatRef);
    batch.delete(payerRef);
    linkedUsers.docs.forEach((u) => {
      batch.set(
        u.ref,
        {
          role: 'REMOVED',
          appBlocked: true,
          flatId: FieldValue.delete(),
          flatLabel: FieldValue.delete(),
          staircaseId: FieldValue.delete(),
          street: FieldValue.delete(),
          buildingNo: FieldValue.delete(),
          apartmentNo: FieldValue.delete(),
          removedAtMs: Date.now(),
          removedByUid: uid,
        },
        { merge: true },
      );
    });
    await batch.commit();

    const communityData = communitySnap.data() || {};
    const usedBefore = getSeatUsed(communityData as any, 1);
    const usedAfter = Math.max(0, usedBefore - 1);
    await communityRef.set({ seatsUsed: usedAfter, updatedAtMs: Date.now() }, { merge: true });

    return NextResponse.json({ ok: true, flatId, seatUsed: usedAfter });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Błąd usuwania lokalu.' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 });
}
