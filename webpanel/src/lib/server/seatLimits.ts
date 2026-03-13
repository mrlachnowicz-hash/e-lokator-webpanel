function asNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export type SeatState = {
  limit: number | null;
  used: number;
  remaining: number | null;
  source: string | null;
};

const LIMIT_KEYS = [
  'appSeatsTotal',
  'seatsTotal',
  'panelSeats',
  'panelSeatsLimit',
  'seats',
  'seatsLimit',
  'totalSeats',
  'maxSeats',
  'purchasedSeats',
  'seatsPurchased',
  'flatsLimit',
  'localsLimit',
  'localiLimit',
  'unitsLimit',
  'licenses',
  'seatCount',
];

const USED_KEYS = [
  'appSeatsUsed',
  'seatsUsed',
  'occupiedSeats',
  'residentCount',
  'usersCount',
  'panelSeatsUsed',
];

export function getSeatLimit(communityData: Record<string, any> | null | undefined): { limit: number | null; source: string | null } {
  if (!communityData) return { limit: null, source: null };
  for (const key of LIMIT_KEYS) {
    const value = asNum(communityData[key]);
    if (value != null) return { limit: Math.max(0, Math.floor(value)), source: key };
  }
  return { limit: null, source: null };
}

export function getSeatUsed(communityData: Record<string, any> | null | undefined, fallback: number): number {
  if (communityData) {
    for (const key of USED_KEYS) {
      const value = asNum(communityData[key]);
      if (value != null) return Math.max(0, Math.floor(value));
    }
  }
  return Math.max(0, Math.floor(fallback));
}

export function getSeatState(communityData: Record<string, any> | null | undefined, fallbackUsed: number): SeatState {
  const { limit, source } = getSeatLimit(communityData);
  const used = getSeatUsed(communityData, fallbackUsed);
  if (limit == null) return { limit: null, used, remaining: null, source };
  return { limit, used, remaining: limit - used, source };
}

export function canCreateFlat(seatState: SeatState) {
  return seatState.limit == null || seatState.remaining == null || seatState.remaining > 0;
}
