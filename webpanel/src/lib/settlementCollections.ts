export const SETTLEMENTS_COLLECTION = "settlements";
export const SETTLEMENT_DRAFTS_COLLECTION = "settlementDrafts";

export function isPublishedSettlement(value: any) {
  return value?.isPublished === true || String(value?.status || "").toUpperCase() === "PUBLISHED";
}

export function mergeSettlementsForView(drafts: any[], published: any[]) {
  const items = [
    ...drafts.map((item) => ({ ...item, __collection: SETTLEMENT_DRAFTS_COLLECTION, isPublished: false })),
    ...published.map((item) => ({ ...item, __collection: SETTLEMENTS_COLLECTION, isPublished: true })),
  ];
  return items.sort((a, b) => Number(b.updatedAtMs || b.createdAtMs || 0) - Number(a.updatedAtMs || a.createdAtMs || 0));
}
