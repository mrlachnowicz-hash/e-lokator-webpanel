export const SETTLEMENTS_COLLECTION = "settlements";
export const SETTLEMENT_DRAFTS_COLLECTION = "settlementDrafts";

export function isPublishedSettlement(value: any) {
  return value?.isPublished === true || String(value?.status || "").toUpperCase() === "PUBLISHED";
}

export function mergeSettlementsForView(drafts: any[], published: any[]) {
  const map = new Map<string, any>();
  drafts.forEach((item) => {
    map.set(String(item.id), { ...item, __collection: SETTLEMENT_DRAFTS_COLLECTION, isPublished: false });
  });
  published.forEach((item) => {
    map.set(String(item.id), { ...item, __collection: SETTLEMENTS_COLLECTION, isPublished: true });
  });
  return Array.from(map.values()).sort((a, b) => Number(b.updatedAtMs || b.createdAtMs || 0) - Number(a.updatedAtMs || a.createdAtMs || 0));
}
