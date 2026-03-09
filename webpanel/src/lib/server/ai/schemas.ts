export type InvoiceAISuggestion = {
  category: string;
  allocationType: "COMMON" | "BUILDING" | "FLAT";
  suggestedBuildingId?: string;
  suggestedFlatId?: string;
  confidence: number;
  needsReview: boolean;
  reason: string;
};

export function safeJsonParse<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; } catch { return fallback; }
}
