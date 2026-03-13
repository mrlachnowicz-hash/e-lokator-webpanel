import { NextResponse } from "next/server";
import { PanelAuthError, requirePanelAccess } from "@/lib/server/panelAuth";

export const runtime = "nodejs";

const ALLOWED_SETTLEMENT_COLLECTIONS = new Set(["settlementDrafts", "settlements"]);

function safe(value: unknown): string {
  return String(value || "").trim();
}

async function getDraftLocation(
  db: FirebaseFirestore.Firestore,
  communityId: string,
  settlementId: string
) {
  const nestedRef = db.doc(`communities/${communityId}/settlementDrafts/${settlementId}`);
  const legacyRef = db.doc(`settlementDrafts/${settlementId}`);
  const [nestedSnap, rawLegacySnap] = await Promise.all([
    nestedRef.get(),
    legacyRef.get().catch(() => null as any),
  ]);

  const legacyMatches = !!rawLegacySnap?.exists && safe(rawLegacySnap.data()?.communityId) === communityId;

  return {
    nestedRef,
    nestedSnap,
    legacyRef: legacyMatches ? legacyRef : null,
    legacySnap: legacyMatches ? rawLegacySnap : null,
  };
}

function buildMigratedDraftData(
  communityId: string,
  settlementId: string,
  baseData: any,
  patch: Record<string, unknown>
) {
  return {
    ...(baseData || {}),
    ...patch,
    communityId: safe(baseData?.communityId) || communityId,
    updatedAtMs: Number(patch.updatedAtMs || baseData?.updatedAtMs || Date.now()),
    legacySettlementDraftId: settlementId,
  };
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const communityId = safe(body?.communityId);
    const settlementId = safe(body?.settlementId);
    const collectionName = safe(body?.collection || body?.targetCollection || "settlementDrafts");
    if (!settlementId || !ALLOWED_SETTLEMENT_COLLECTIONS.has(collectionName)) {
      return NextResponse.json({ error: "Brak settlementId lub nieprawidłowa kolekcja." }, { status: 400 });
    }

    const { db } = await requirePanelAccess(req, { communityId });
    const paymentPatch =
      body?.paymentPatch && typeof body.paymentPatch === "object"
        ? { ...(body.paymentPatch as Record<string, unknown>) }
        : {};
    if (!Object.prototype.hasOwnProperty.call(paymentPatch, "updatedAtMs")) {
      paymentPatch.updatedAtMs = Date.now();
    }

    let resolvedTarget: "community" | "migratedLegacy" | "communityCleanupLegacy" = "community";

    if (collectionName === "settlementDrafts") {
      const location = await getDraftLocation(db, communityId, settlementId);
      const batch = db.batch();

      if (location.nestedSnap.exists) {
        batch.set(location.nestedRef, paymentPatch, { merge: true });
        if (location.legacyRef) {
          batch.delete(location.legacyRef);
          resolvedTarget = "communityCleanupLegacy";
        }
      } else if (location.legacySnap?.exists) {
        batch.set(
          location.nestedRef,
          buildMigratedDraftData(communityId, settlementId, location.legacySnap.data() || {}, paymentPatch),
          { merge: true }
        );
        if (location.legacyRef) {
          batch.delete(location.legacyRef);
        }
        resolvedTarget = "migratedLegacy";
      } else {
        batch.set(location.nestedRef, paymentPatch, { merge: true });
      }

      const flatId = safe(body?.flatId);
      const flatPatch =
        body?.flatPatch && typeof body.flatPatch === "object"
          ? { ...(body.flatPatch as Record<string, unknown>) }
          : null;
      if (flatId && flatPatch) {
        if (!Object.prototype.hasOwnProperty.call(flatPatch, "updatedAtMs")) {
          flatPatch.updatedAtMs = Date.now();
        }
        batch.set(db.doc(`communities/${communityId}/flats/${flatId}`), flatPatch, { merge: true });
      }

      await batch.commit();
    } else {
      await db.doc(`communities/${communityId}/${collectionName}/${settlementId}`).set(paymentPatch, { merge: true });

      const flatId = safe(body?.flatId);
      const flatPatch =
        body?.flatPatch && typeof body.flatPatch === "object"
          ? { ...(body.flatPatch as Record<string, unknown>) }
          : null;
      if (flatId && flatPatch) {
        if (!Object.prototype.hasOwnProperty.call(flatPatch, "updatedAtMs")) {
          flatPatch.updatedAtMs = Date.now();
        }
        await db.doc(`communities/${communityId}/flats/${flatId}`).set(flatPatch, { merge: true });
      }
    }

    return NextResponse.json({
      ok: true,
      settlementId,
      collection: collectionName,
      resolvedTarget,
    });
  } catch (error: any) {
    if (error instanceof PanelAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: error?.message || "Błąd zapisu danych płatności." }, { status: 500 });
  }
}
