import { NextResponse } from "next/server";
import { PanelAuthError, requirePanelAccess } from "@/lib/server/panelAuth";

export const runtime = "nodejs";

const ALLOWED_SETTLEMENT_COLLECTIONS = new Set(["settlementDrafts", "settlements"]);

function safe(value: unknown): string {
  return String(value || "").trim();
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const communityId = safe(body?.communityId);
    const { db } = await requirePanelAccess(req, { communityId });

    const communityPatch = (body?.communityPatch && typeof body.communityPatch === "object") ? { ...(body.communityPatch as Record<string, unknown>) } : {};
    if (!Object.prototype.hasOwnProperty.call(communityPatch, "updatedAtMs")) {
      communityPatch.updatedAtMs = Date.now();
    }
    await db.doc(`communities/${communityId}`).set(communityPatch, { merge: true });

    const settlementPatches = Array.isArray(body?.settlementPatches) ? body.settlementPatches : [];
    if (settlementPatches.length) {
      let batch = db.batch();
      let ops = 0;
      for (const item of settlementPatches) {
        const settlementId = safe(item?.settlementId || item?.id);
        const collectionName = safe(item?.collection || item?.targetCollection || "settlementDrafts");
        const patch = (item?.patch && typeof item.patch === "object") ? { ...(item.patch as Record<string, unknown>) } : {};
        if (!settlementId || !ALLOWED_SETTLEMENT_COLLECTIONS.has(collectionName)) continue;
        if (!Object.prototype.hasOwnProperty.call(patch, "updatedAtMs")) {
          patch.updatedAtMs = Date.now();
        }
        batch.set(db.doc(`communities/${communityId}/${collectionName}/${settlementId}`), patch, { merge: true });
        ops += 1;
        if (ops >= 400) {
          await batch.commit();
          batch = db.batch();
          ops = 0;
        }
      }
      if (ops > 0) await batch.commit();
    }

    return NextResponse.json({ ok: true, settlementPatchCount: settlementPatches.length });
  } catch (error: any) {
    if (error instanceof PanelAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: error?.message || "Błąd zapisu ustawień płatności." }, { status: 500 });
  }
}
