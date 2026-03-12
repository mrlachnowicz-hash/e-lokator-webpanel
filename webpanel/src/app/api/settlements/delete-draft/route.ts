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
    await db.doc(`communities/${communityId}/settlementDrafts/${settlementId}`).delete();
    return NextResponse.json({ ok: true, settlementId });
  } catch (error: any) {
    if (error instanceof PanelAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: error?.message || "Błąd usuwania szkicu." }, { status: 500 });
  }
}
