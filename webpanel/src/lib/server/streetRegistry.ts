import { Firestore } from 'firebase-admin/firestore';

function normalizeStreetName(name: string) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function ensureStreet(db: Firestore, communityId: string, streetName: string, userUid?: string) {
  const name = String(streetName || '').trim();
  if (!communityId || !name) return null;
  const streetId = normalizeStreetName(name);
  if (!streetId) return null;
  const now = Date.now();
  const ref = db.doc(`communities/${communityId}/streets/${streetId}`);
  await ref.set({
    id: streetId,
    name,
    normalizedName: streetId,
    communityId,
    isActive: true,
    updatedAtMs: now,
    ...(userUid ? { updatedByUid: userUid } : {}),
    createdAtMs: now,
  }, { merge: true });
  return { id: streetId, name };
}
