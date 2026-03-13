import { NextResponse } from "next/server";
import { PanelAuthError, requirePanelAccess } from "@/lib/server/panelAuth";

export const runtime = "nodejs";

function safe(value: unknown): string {
  return String(value || "").trim();
}

async function hasRealAppUser(adminDb: FirebaseFirestore.Firestore, candidateUid: string) {
  const uid = safe(candidateUid);
  if (!uid || uid.startsWith("payer_") || uid.startsWith("shadow_")) return false;
  const userSnap = await adminDb.doc(`users/${uid}`).get().catch(() => null as any);
  if (!userSnap?.exists) return false;
  const user = userSnap.data() || {};
  const role = safe(user.role).toUpperCase();
  if (role === "REMOVED") return false;
  if (user.isShadow === true || user.placeholderResident === true) return false;
  if (user.removedAtMs != null) return false;
  return true;
}

async function sendEmailFallback(origin: string, settlementId: string, communityId: string, token: string) {
  try {
    await fetch(`${origin}/api/settlements/${encodeURIComponent(settlementId)}/send-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ communityId }),
    });
  } catch {}
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const communityId = safe(body?.communityId);
    const periodFilter = safe(body?.period);
    if (!communityId) return NextResponse.json({ error: "Missing communityId" }, { status: 400 });

    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const { db: adminDb } = await requirePanelAccess(req, { communityId });

    const emptySnap = { docs: [] as FirebaseFirestore.QueryDocumentSnapshot[] };
    const [communitySnap, legacySnap] = await Promise.all([
      adminDb.collection(`communities/${communityId}/settlementDrafts`).get(),
      adminDb
        .collection(`settlementDrafts`)
        .where("communityId", "==", communityId)
        .get()
        .catch(() => emptySnap as any),
    ]);

    const dedupe = new Map<
      string,
      {
        id: string;
        data: any;
        sourceRef: FirebaseFirestore.DocumentReference | null;
        duplicateRefs: FirebaseFirestore.DocumentReference[];
      }
    >();

    for (const docSnap of communitySnap.docs) {
      const data: any = docSnap.data() || {};
      if (periodFilter && safe(data.period || data.archiveMonth) !== periodFilter) continue;
      dedupe.set(docSnap.id, {
        id: docSnap.id,
        data,
        sourceRef: docSnap.ref,
        duplicateRefs: [],
      });
    }

    for (const docSnap of legacySnap.docs || []) {
      const data: any = docSnap.data() || {};
      if (periodFilter && safe(data.period || data.archiveMonth) !== periodFilter) continue;
      const existing = dedupe.get(docSnap.id);
      if (existing) {
        existing.duplicateRefs.push(docSnap.ref);
        continue;
      }
      dedupe.set(docSnap.id, {
        id: docSnap.id,
        data,
        sourceRef: docSnap.ref,
        duplicateRefs: [],
      });
    }

    const docs = Array.from(dedupe.values()).sort(
      (a, b) => Number(b.data?.updatedAtMs || b.data?.createdAtMs || 0) - Number(a.data?.updatedAtMs || a.data?.createdAtMs || 0)
    );

    if (!docs.length) {
      return NextResponse.json({
        ok: true,
        published: 0,
        publishedCount: 0,
        emailFallbackCount: 0,
        settlementIds: [],
      });
    }

    const now = Date.now();
    let batch = adminDb.batch();
    let ops = 0;
    const commitIfNeeded = async () => {
      if (ops < 380) return;
      await batch.commit();
      batch = adminDb.batch();
      ops = 0;
    };

    for (const entry of docs) {
      const data: any = entry.data || {};
      batch.set(
        adminDb.doc(`communities/${communityId}/settlements/${entry.id}`),
        {
          ...data,
          communityId,
          isPublished: true,
          status: "PUBLISHED",
          publishedAtMs: now,
          updatedAtMs: now,
          archiveMonth: safe(data.period || data.archiveMonth),
        },
        { merge: true }
      );
      ops += 1;
      await commitIfNeeded();

      if (entry.sourceRef) {
        batch.delete(entry.sourceRef);
        ops += 1;
        await commitIfNeeded();
      }

      for (const duplicateRef of entry.duplicateRefs) {
        batch.delete(duplicateRef);
        ops += 1;
        await commitIfNeeded();
      }
    }

    if (ops > 0) {
      await batch.commit();
    }

    let emailFallbackCount = 0;
    const origin = new URL(req.url).origin;
    for (const settlementDoc of docs) {
      const data: any = settlementDoc.data || {};
      if (!data.flatId) continue;
      const flatSnap = await adminDb.doc(`communities/${communityId}/flats/${data.flatId}`).get().catch(() => null as any);
      const flat: any = flatSnap?.exists ? flatSnap.data() : {};
      const candidateUid = safe(flat?.residentUid || flat?.userId || data?.residentUid || data?.userId);
      const hasAppUser = await hasRealAppUser(adminDb, candidateUid);
      const email = safe(data.email || data.residentEmail || flat?.email);
      if (!hasAppUser && email) {
        emailFallbackCount += 1;
        if (token) await sendEmailFallback(origin, settlementDoc.id, communityId, token);
      }
    }

    return NextResponse.json({
      ok: true,
      published: docs.length,
      publishedCount: docs.length,
      emailFallbackCount,
      settlementIds: docs.map((doc) => doc.id),
    });
  } catch (error: any) {
    if (error instanceof PanelAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: error?.message || "Publish all error" }, { status: 500 });
  }
}
