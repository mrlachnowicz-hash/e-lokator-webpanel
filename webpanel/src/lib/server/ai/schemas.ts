export type InvoiceAISuggestion = {
  category: string;
  allocationType: "COMMON" | "BUILDING" | "STAIRCASE" | "COMMUNITY" | "FLAT" | "UNKNOWN";
  suggestedBuildingId?: string;
  suggestedFlatId?: string;
  suggestedStreetId?: string;
  suggestedStreetName?: string;
  suggestedApartmentNo?: string;
  suggestedStaircaseId?: string;
  confidence: number;
  needsReview: boolean;
  reason: string;
};

export function safeJsonParse<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; } catch { return fallback; }
}
