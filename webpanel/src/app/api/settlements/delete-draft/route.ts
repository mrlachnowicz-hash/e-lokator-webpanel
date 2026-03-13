import { NextResponse } from "next/server";
import { PanelAuthError, requirePanelAccess } from "@/lib/server/panelAuth";

export const runtime = "nodejs";

function safe(value: unknown): string {
  return String(value || "").trim();
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const communityId = safe(body?.communityId);
    const settlementId = safe(body?.settlementId);
    if (!settlementId) {
      return NextResponse.json({ error: "Brak settlementId." }, { status: 400 });
    }

    const { db } = await requirePanelAccess(req, { communityId });
    const nestedRef = db.doc(`communities/${communityId}/settlementDrafts/${settlementId}`);
    const legacyRef = db.doc(`settlementDrafts/${settlementId}`);
    const [nestedSnap, rawLegacySnap] = await Promise.all([
      nestedRef.get(),
      legacyRef.get().catch(() => null as any),
    ]);

    const batch = db.batch();
    let deleted = 0;

    if (nestedSnap.exists) {
      batch.delete(nestedRef);
      deleted += 1;
    }
    if (rawLegacySnap?.exists && safe(rawLegacySnap.data()?.communityId) === communityId) {
      batch.delete(legacyRef);
      deleted += 1;
    }

    if (deleted > 0) {
      await batch.commit();
    }

    return NextResponse.json({ ok: true, settlementId, deleted });
  } catch (error: any) {
    if (error instanceof PanelAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: error?.message || "Błąd usuwania szkicu." }, { status: 500 });
  }
}
