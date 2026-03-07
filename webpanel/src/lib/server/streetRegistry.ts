function normalizeStreetName(value: string) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function buildStreetId(name: string) {
  return normalizeStreetName(name);
}

export async function ensureStreetDoc(
  tx: FirebaseFirestore.Transaction,
  communityRef: FirebaseFirestore.DocumentReference,
  streetName: string,
  actorUid?: string | null,
) {
  const name = String(streetName || '').trim();
  if (!name) return null;
  const streetId = buildStreetId(name);
  const streetRef = communityRef.collection('streets').doc(streetId);
  const snap = await tx.get(streetRef);
  const now = Date.now();
  const current = snap.data() || {};
  tx.set(
    streetRef,
    {
      name,
      nameNorm: streetId,
      updatedAtMs: now,
      createdAtMs: Number((current as any).createdAtMs || now),
      ...(actorUid ? { updatedByUid: actorUid } : {}),
    },
    { merge: true },
  );
  return { streetId, streetRef };
}
