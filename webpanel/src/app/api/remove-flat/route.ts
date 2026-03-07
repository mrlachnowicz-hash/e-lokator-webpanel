import * as admin from "firebase-admin";
import { NextRequest, NextResponse } from 'next/server';
import { getAdminApp, getAdminDb } from '../../../lib/server/firebaseAdmin';

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
    const flatId = String(body?.flatId || '').trim();
    if (!communityId || !flatId) return NextResponse.json({ error: 'Brak communityId lub flatId.' }, { status: 400 });

    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return NextResponse.json({ error: 'Nie znaleziono profilu użytkownika.' }, { status: 403 });
    const userData = userSnap.data() || {};
    const role = String((userData as any).role || '').toUpperCase();
    const userCommunityId = String((userData as any).communityId || (userData as any).customerId || '').trim();
    if (!['MASTER', 'ACCOUNTANT'].includes(role)) return NextResponse.json({ error: 'Brak uprawnień.' }, { status: 403 });
    if (userCommunityId && userCommunityId !== communityId) return NextResponse.json({ error: 'Inna wspólnota.' }, { status: 403 });

    const communityRef = db.collection('communities').doc(communityId);
    await Promise.all([
      communityRef.collection('flats').doc(flatId).delete(),
      communityRef.collection('payers').doc(flatId).delete().catch(() => undefined),
    ]);

    const usersSnap = await db.collection('users').where('communityId','==',communityId).where('flatId','==',flatId).get();
    const batch = db.batch();
    usersSnap.docs.forEach((d) => batch.set(d.ref, {
      flatId: admin.firestore.FieldValue.delete(),
      flatLabel: admin.firestore.FieldValue.delete(),
      street: admin.firestore.FieldValue.delete(),
      buildingNo: admin.firestore.FieldValue.delete(),
      apartmentNo: admin.firestore.FieldValue.delete(),
      updatedAtMs: Date.now(),
    }, { merge: true }));
    await batch.commit();

    const remainingSnap = await communityRef.collection('flats').get();
    const usedAfter = remainingSnap.size;
    await communityRef.set({ seatsUsed: usedAfter, updatedAtMs: Date.now() }, { merge: true });

    return NextResponse.json({ ok: true, seatUsed: usedAfter });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Błąd usuwania lokalu.' }, { status: 500 });
  }
}
