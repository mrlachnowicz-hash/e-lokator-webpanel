import { getAdminDb } from "./firebaseAdmin";
import type { PaymentRecord, SettlementRecord } from "../settlementShared";
import { inferRelatedPayments } from "../settlementShared";

export async function getSettlementBundle(communityId: string, settlementId: string) {
  const db = getAdminDb();
  const settlementRef = db.doc(`communities/${communityId}/settlements/${settlementId}`);
  const settlementSnap = await settlementRef.get();

  if (!settlementSnap.exists) {
    throw new Error("Settlement not found");
  }

  const settlement = { id: settlementSnap.id, ...(settlementSnap.data() as any) } as SettlementRecord;

  const [paymentsSnap, flatSnap, payerSnap, communitySnap] = await Promise.all([
    db.collection(`communities/${communityId}/payments`).orderBy("createdAtMs", "desc").limit(500).get().catch(async () => db.collection(`communities/${communityId}/payments`).get()),
    settlement.flatId ? db.doc(`communities/${communityId}/flats/${settlement.flatId}`).get() : Promise.resolve(null as any),
    settlement.flatId ? db.doc(`communities/${communityId}/payers/${settlement.flatId}`).get() : Promise.resolve(null as any),
    db.doc(`communities/${communityId}`).get(),
  ]);

  const payments = paymentsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as PaymentRecord[];
  const relatedPayments = inferRelatedPayments(payments, settlement).slice(0, 50);

  const flat = flatSnap?.exists ? ({ id: flatSnap.id, ...(flatSnap.data() as any) }) : null;
  const payer = payerSnap?.exists ? ({ id: payerSnap.id, ...(payerSnap.data() as any) }) : null;
  const community = communitySnap.exists ? communitySnap.data() : null;

  const email = String(
    settlement.email
      || flat?.email
      || payer?.email
      || ""
  ).trim();

  return { settlementRef, settlement, relatedPayments, flat, payer, community, email };
}
