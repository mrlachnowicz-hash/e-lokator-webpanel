import { NextResponse } from "next/server";
import { buildStablePaymentTitle, normalizeAccountNumber, normalizePaymentRef } from "@/lib/paymentRefs";
import { PanelAuthError, requirePanelAccess } from "@/lib/server/panelAuth";

export const runtime = "nodejs";

const ALLOWED_SETTLEMENT_COLLECTIONS = new Set(["settlementDrafts", "settlements"]);

type PaymentDefaults = {
  accountNumber: string;
  recipientName: string;
  recipientAddress: string;
};

type DraftLocation = {
  nestedRef: FirebaseFirestore.DocumentReference;
  nestedSnap: FirebaseFirestore.DocumentSnapshot;
  legacyRef: FirebaseFirestore.DocumentReference | null;
  legacySnap: FirebaseFirestore.DocumentSnapshot | null;
};

function safe(value: unknown): string {
  return String(value || "").trim();
}

function normalizeText(value: unknown): string {
  return String(value || "").trim();
}

function sameAccount(a: unknown, b: unknown) {
  return normalizeAccountNumber(a) === normalizeAccountNumber(b);
}

function sameText(a: unknown, b: unknown) {
  return normalizeText(a) === normalizeText(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readCommunityDefaults(data: any): PaymentDefaults {
  return {
    accountNumber: String(
      data?.defaultAccountNumber ||
        data?.accountNumber ||
        data?.bankAccount ||
        data?.paymentSettings?.accountNumber ||
        data?.paymentDefaults?.accountNumber ||
        ""
    ),
    recipientName: String(
      data?.recipientName ||
        data?.receiverName ||
        data?.transferName ||
        data?.paymentSettings?.recipientName ||
        data?.paymentDefaults?.recipientName ||
        ""
    ),
    recipientAddress: String(
      data?.recipientAddress ||
        data?.receiverAddress ||
        data?.transferAddress ||
        data?.paymentSettings?.recipientAddress ||
        data?.paymentDefaults?.recipientAddress ||
        ""
    ),
  };
}

function mergeCommunityLike(previous: any, patch: Record<string, unknown>) {
  return {
    ...(previous || {}),
    ...patch,
    paymentSettings: {
      ...(previous?.paymentSettings || {}),
      ...(isRecord(patch?.paymentSettings) ? patch.paymentSettings : {}),
    },
    paymentDefaults: {
      ...(previous?.paymentDefaults || {}),
      ...(isRecord(patch?.paymentDefaults) ? patch.paymentDefaults : {}),
    },
  };
}

function settlementRefForDraft(communityId: string, settlement: any, flat?: any) {
  return (
    normalizePaymentRef(
      settlement?.paymentRef ||
        settlement?.paymentTitle ||
        settlement?.transferTitle ||
        settlement?.paymentCode ||
        ""
    ) ||
    buildStablePaymentTitle({
      communityId,
      flatId: settlement?.flatId || flat?.id || "",
      flatLabel: settlement?.flatLabel || flat?.flatLabel || "",
      street: settlement?.street || flat?.street || flat?.streetName || "",
      buildingNo: settlement?.buildingNo || flat?.buildingNo || "",
      apartmentNo:
        settlement?.apartmentNo ||
        flat?.apartmentNo ||
        flat?.flatNumber ||
        settlement?.flatNumber ||
        "",
      period: settlement?.period || new Date().toISOString().slice(0, 7),
    })
  );
}

async function getDraftLocation(
  db: FirebaseFirestore.Firestore,
  communityId: string,
  settlementId: string
): Promise<DraftLocation> {
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

function buildDraftDefaultsPatch(
  communityId: string,
  settlement: any,
  flat: any,
  previousDefaults: PaymentDefaults,
  nextDefaults: PaymentDefaults
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  if (
    nextDefaults.accountNumber &&
    (!normalizeAccountNumber(settlement?.accountNumber || settlement?.bankAccount) ||
      sameAccount(settlement?.accountNumber || settlement?.bankAccount, previousDefaults.accountNumber))
  ) {
    patch.accountNumber = nextDefaults.accountNumber;
    patch.bankAccount = nextDefaults.accountNumber;
  }

  if (
    nextDefaults.recipientName &&
    (!normalizeText(settlement?.transferName || settlement?.receiverName) ||
      sameText(settlement?.transferName || settlement?.receiverName, previousDefaults.recipientName))
  ) {
    patch.transferName = nextDefaults.recipientName;
    patch.receiverName = nextDefaults.recipientName;
  }

  if (
    nextDefaults.recipientAddress &&
    (!normalizeText(settlement?.transferAddress || settlement?.receiverAddress) ||
      sameText(
        settlement?.transferAddress || settlement?.receiverAddress,
        previousDefaults.recipientAddress
      ))
  ) {
    patch.transferAddress = nextDefaults.recipientAddress;
    patch.receiverAddress = nextDefaults.recipientAddress;
  }

  const paymentRef = settlementRefForDraft(communityId, settlement, flat);
  const currentRef = normalizePaymentRef(
    settlement?.paymentRef ||
      settlement?.paymentTitle ||
      settlement?.transferTitle ||
      settlement?.paymentCode ||
      ""
  );

  if (
    paymentRef &&
    (currentRef !== paymentRef ||
      settlement?.paymentTitle !== paymentRef ||
      settlement?.transferTitle !== paymentRef ||
      settlement?.paymentCode !== paymentRef)
  ) {
    patch.paymentRef = paymentRef;
    patch.paymentTitle = paymentRef;
    patch.transferTitle = paymentRef;
    patch.paymentCode = paymentRef;
  }

  return patch;
}

function hasPatchValues(patch: Record<string, unknown>) {
  return Object.keys(patch).length > 0;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const communityId = safe(body?.communityId);
    const { db } = await requirePanelAccess(req, { communityId });

    const communityRef = db.doc(`communities/${communityId}`);
    const communitySnap = await communityRef.get();
    const previousCommunityData = communitySnap.data() || {};

    const communityPatch =
      body?.communityPatch && typeof body.communityPatch === "object"
        ? { ...(body.communityPatch as Record<string, unknown>) }
        : {};
    if (!Object.prototype.hasOwnProperty.call(communityPatch, "updatedAtMs")) {
      communityPatch.updatedAtMs = Date.now();
    }
    await communityRef.set(communityPatch, { merge: true });

    const previousDefaults = readCommunityDefaults(previousCommunityData);
    const nextDefaults = readCommunityDefaults(mergeCommunityLike(previousCommunityData, communityPatch));

    const queuedWrites = new Map<
      string,
      { ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }
    >();
    const queuedDeletes = new Map<string, FirebaseFirestore.DocumentReference>();

    const queueWrite = (
      ref: FirebaseFirestore.DocumentReference,
      data: Record<string, unknown> | null | undefined
    ) => {
      if (!data || !hasPatchValues(data)) return;
      const current = queuedWrites.get(ref.path);
      queuedWrites.set(ref.path, {
        ref,
        data: {
          ...(current?.data || {}),
          ...data,
          updatedAtMs: Number(data.updatedAtMs || current?.data?.updatedAtMs || Date.now()),
        },
      });
    };

    const queueDelete = (ref: FirebaseFirestore.DocumentReference | null | undefined) => {
      if (!ref) return;
      if (queuedWrites.has(ref.path)) return;
      queuedDeletes.set(ref.path, ref);
    };

    const settlementPatches = Array.isArray(body?.settlementPatches) ? body.settlementPatches : [];
    let explicitPatchCount = 0;
    let explicitLegacyMigrationCount = 0;
    let explicitLegacyCleanupCount = 0;

    for (const item of settlementPatches) {
      const settlementId = safe(item?.settlementId || item?.id);
      const collectionName = safe(item?.collection || item?.targetCollection || "settlementDrafts");
      const patch =
        item?.patch && typeof item.patch === "object"
          ? { ...(item.patch as Record<string, unknown>) }
          : {};
      if (!settlementId || !ALLOWED_SETTLEMENT_COLLECTIONS.has(collectionName)) continue;
      if (!Object.prototype.hasOwnProperty.call(patch, "updatedAtMs")) {
        patch.updatedAtMs = Date.now();
      }

      explicitPatchCount += 1;

      if (collectionName !== "settlementDrafts") {
        queueWrite(db.doc(`communities/${communityId}/${collectionName}/${settlementId}`), patch);
        continue;
      }

      const location = await getDraftLocation(db, communityId, settlementId);

      if (location.nestedSnap.exists) {
        queueWrite(location.nestedRef, patch);
        if (location.legacyRef) {
          queueDelete(location.legacyRef);
          explicitLegacyCleanupCount += 1;
        }
        continue;
      }

      if (location.legacySnap?.exists) {
        queueWrite(
          location.nestedRef,
          buildMigratedDraftData(communityId, settlementId, location.legacySnap.data() || {}, patch)
        );
        queueDelete(location.legacyRef);
        explicitLegacyMigrationCount += 1;
        continue;
      }

      queueWrite(location.nestedRef, patch);
    }

    const shouldPropagateDraftDefaults = body?.syncDraftDefaults !== false;
    let propagatedDraftCount = 0;
    let propagatedLegacyMigrationCount = 0;
    let propagatedLegacyCleanupCount = 0;

    if (
      shouldPropagateDraftDefaults &&
      (nextDefaults.accountNumber || nextDefaults.recipientName || nextDefaults.recipientAddress)
    ) {
      const emptySnap = { docs: [] as FirebaseFirestore.QueryDocumentSnapshot[] };
      const [draftSnap, legacyDraftSnap, flatsSnap] = await Promise.all([
        db.collection(`communities/${communityId}/settlementDrafts`).get(),
        db
          .collection("settlementDrafts")
          .where("communityId", "==", communityId)
          .get()
          .catch(() => emptySnap as any),
        db.collection(`communities/${communityId}/flats`).get().catch(() => emptySnap as any),
      ]);

      const flatById = new Map<string, any>(
        (flatsSnap.docs || []).map((docSnap: any) => [docSnap.id, { id: docSnap.id, ...(docSnap.data() || {}) }])
      );

      const draftTargets = new Map<
        string,
        {
          id: string;
          data: any;
          writeRef: FirebaseFirestore.DocumentReference;
          cleanupLegacyRef?: FirebaseFirestore.DocumentReference | null;
          mode: "community" | "legacy";
        }
      >();

      for (const docSnap of draftSnap.docs || []) {
        draftTargets.set(docSnap.id, {
          id: docSnap.id,
          data: { id: docSnap.id, ...(docSnap.data() || {}) },
          writeRef: docSnap.ref,
          mode: "community",
        });
      }

      for (const docSnap of legacyDraftSnap.docs || []) {
        const existing = draftTargets.get(docSnap.id);
        if (existing) {
          queueDelete(docSnap.ref);
          propagatedLegacyCleanupCount += 1;
          continue;
        }
        draftTargets.set(docSnap.id, {
          id: docSnap.id,
          data: { id: docSnap.id, ...(docSnap.data() || {}) },
          writeRef: db.doc(`communities/${communityId}/settlementDrafts/${docSnap.id}`),
          cleanupLegacyRef: docSnap.ref,
          mode: "legacy",
        });
      }

      for (const entry of draftTargets.values()) {
        const settlement = entry.data || {};
        const flat = flatById.get(String(settlement.flatId || "")) || null;
        const patch = buildDraftDefaultsPatch(
          communityId,
          settlement,
          flat,
          previousDefaults,
          nextDefaults
        );

        if (entry.mode === "legacy") {
          queueWrite(
            entry.writeRef,
            buildMigratedDraftData(communityId, entry.id, settlement, {
              ...patch,
              updatedAtMs: Number((patch as any).updatedAtMs || settlement?.updatedAtMs || Date.now()),
            })
          );
          queueDelete(entry.cleanupLegacyRef);
          propagatedLegacyMigrationCount += 1;
          if (hasPatchValues(patch)) propagatedDraftCount += 1;
          continue;
        }

        if (!hasPatchValues(patch)) continue;
        patch.updatedAtMs = Date.now();
        queueWrite(entry.writeRef, patch);
        propagatedDraftCount += 1;
      }
    }

    if (queuedWrites.size || queuedDeletes.size) {
      let batch = db.batch();
      let ops = 0;

      for (const entry of queuedWrites.values()) {
        batch.set(entry.ref, entry.data, { merge: true });
        ops += 1;
        if (ops >= 380) {
          await batch.commit();
          batch = db.batch();
          ops = 0;
        }
      }

      for (const ref of queuedDeletes.values()) {
        batch.delete(ref);
        ops += 1;
        if (ops >= 380) {
          await batch.commit();
          batch = db.batch();
          ops = 0;
        }
      }

      if (ops > 0) {
        await batch.commit();
      }
    }

    return NextResponse.json({
      ok: true,
      settlementPatchCount: explicitPatchCount,
      explicitLegacyMigrationCount,
      explicitLegacyCleanupCount,
      propagatedDraftCount,
      propagatedLegacyMigrationCount,
      propagatedLegacyCleanupCount,
      appliedWriteCount: queuedWrites.size,
      appliedDeleteCount: queuedDeletes.size,
    });
  } catch (error: any) {
    if (error instanceof PanelAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: error?.message || "Błąd zapisu ustawień płatności." }, { status: 500 });
  }
}
