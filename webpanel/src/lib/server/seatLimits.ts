function asNum(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function pickFirstNumber(source: Record<string, any> | null | undefined, keys: string[]): number | null {
  if (!source) return null;
  for (const key of keys) {
    const value = asNum(source[key]);
    if (value != null) return value;
  }
  return null;
}

export type SeatState = {
  limit: number | null;
  used: number;
  remaining: number | null;
  source: string | null;
};

const LIMIT_KEYS = [
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

export function getSeatState(communityData: Record<string, any> | null | undefined, used: number): SeatState {
  let source: string | null = null;
  let limit: number | null = null;
  if (communityData) {
    for (const key of LIMIT_KEYS) {
      const value = asNum(communityData[key]);
      if (value != null) {
        limit = value;
        source = key;
        break;
      }
    }
  }

  if (limit == null) {
    return { limit: null, used, remaining: null, source: null };
  }

  const normalizedLimit = Math.max(0, Math.floor(limit));
  return {
    limit: normalizedLimit,
    used,
    remaining: normalizedLimit - used,
    source,
  };
}

export function canCreateFlat(seatState: SeatState) {
  return seatState.limit == null || seatState.remaining == null || seatState.remaining > 0;
}
