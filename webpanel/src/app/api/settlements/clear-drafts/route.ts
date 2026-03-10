export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '../../../../lib/server/firebaseAdmin';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const communityId = String(body?.communityId || '').trim();
    if (!communityId) return NextResponse.json({ error: 'Brak communityId.' }, { status: 400 });

    const db = getAdminDb();
    const snap = await db.collection(`communities/${communityId}/settlementDrafts`).get();
    if (snap.empty) return NextResponse.json({ ok: true, deleted: 0 });

    let deleted = 0;
    let batch = db.batch();
    let ops = 0;
    for (const d of snap.docs) {
      batch.delete(d.ref);
      deleted += 1;
      ops += 1;
      if (ops >= 450) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();
    return NextResponse.json({ ok: true, deleted });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Błąd czyszczenia szkiców.' }, { status: 500 });
  }
}
