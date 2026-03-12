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
    const webpanelUrl = safe(body?.webpanelUrl);
    const { db } = await requirePanelAccess(req, { communityId, requirePanelAccess: false });
    await db.doc(`communities/${communityId}`).set({ webpanelUrl, updatedAtMs: Date.now() }, { merge: true });
    return NextResponse.json({ ok: true, webpanelUrl });
  } catch (error: any) {
    if (error instanceof PanelAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: error?.message || "Błąd zapisu adresu webpanelu." }, { status: 500 });
  }
}
