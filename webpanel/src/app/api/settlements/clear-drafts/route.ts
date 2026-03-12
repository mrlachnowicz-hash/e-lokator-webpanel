export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { PanelAuthError, requirePanelAccess } from '@/lib/server/panelAuth';

function safe(value: unknown): string {
  return String(value || '').trim();
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const communityId = safe(body?.communityId);
    const { db } = await requirePanelAccess(req, { communityId });

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
    if (error instanceof PanelAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: error?.message || 'Błąd czyszczenia szkiców.' }, { status: 500 });
  }
}
