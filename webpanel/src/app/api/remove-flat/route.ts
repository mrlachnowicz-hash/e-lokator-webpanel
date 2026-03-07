import { NextRequest, NextResponse } from 'next/server';
import * as admin from 'firebase-admin';
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
    if (!communityId || !flatId) {
      return NextResponse.json({ error: 'Brak communityId lub flatId.' }, { status: 400 });
    }

    const actorSnap = await db.collection('users').doc(uid).get();
    const actor = actorSnap.data() || {};
    const role = String((actor as any).role || '').toUpperCase();
    const actorCommunityId = String((actor as any).communityId || (actor as any).customerId || '').trim();
    if (!['MASTER', 'ACCOUNTANT'].includes(role)) {
      return NextResponse.json({ error: 'Brak uprawnień do usuwania lokali/użytkowników.' }, { status: 403 });
    }
    if (actorCommunityId && actorCommunityId !== communityId) {
      return NextResponse.json({ error: 'communityId nie zgadza się z profilem użytkownika.' }, { status: 403 });
    }

    const flatRef = db.doc(`communities/${communityId}/flats/${flatId}`);
    const payerRef = db.doc(`communities/${communityId}/payers/${flatId}`);
    const communityRef = db.doc(`communities/${communityId}`);
    const [flatSnap, linkedUsersSnap, communitySnap] = await Promise.all([
      flatRef.get(),
      db.collection('users').where('communityId', '==', communityId).where('flatId', '==', flatId).get(),
      communityRef.get(),
    ]);
    if (!flatSnap.exists) return NextResponse.json({ error: 'Lokal nie istnieje.' }, { status: 404 });

    const now = Date.now();
    const batch = db.batch();
    linkedUsersSnap.docs.forEach((userDoc) => {
      batch.set(userDoc.ref, {
        appBlocked: true,
        flatId: admin.firestore.FieldValue.delete(),
        flatLabel: admin.firestore.FieldValue.delete(),
        staircaseId: admin.firestore.FieldValue.delete(),
        residentDeletedAtMs: now,
        removedAtMs: now,
        removedByUid: uid,
        role: 'REMOVED',
        updatedAtMs: now,
      }, { merge: true });
    });
    batch.delete(flatRef);
    batch.delete(payerRef);
    const currentUsed = Number(communitySnap.data()?.seatsUsed || 0);
    batch.set(communityRef, { seatsUsed: Math.max(0, currentUsed - 1), updatedAtMs: now }, { merge: true });
    await batch.commit();

    return NextResponse.json({ ok: true, detachedUsers: linkedUsersSnap.size, seatUsed: Math.max(0, currentUsed - 1) });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Błąd usuwania lokalu.' }, { status: 500 });
  }
}
