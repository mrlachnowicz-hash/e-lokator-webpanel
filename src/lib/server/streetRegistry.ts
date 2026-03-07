import { getAdminDb } from './firebaseAdmin';

function normalizeStreetName(name: string) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export async function ensureStreetExists(communityId: string, streetName: string, userUid?: string) {
  const name = String(streetName || '').trim();
  if (!communityId || !name) return null;
  const streetId = normalizeStreetName(name) || name;
  const db = getAdminDb();
  const ref = db.doc(`communities/${communityId}/streets/${streetId}`);
  await ref.set({
    id: streetId,
    communityId,
    name,
    normalizedName: streetId,
    isActive: true,
    updatedAtMs: Date.now(),
    createdAtMs: Date.now(),
    createdByUid: userUid || null,
  }, { merge: true });
  return streetId;
}
