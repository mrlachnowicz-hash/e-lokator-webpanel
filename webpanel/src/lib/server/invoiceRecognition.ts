import { buildFlatLabel } from "@/lib/flatMapping";

export type FlatCandidate = {
  id: string;
  street?: string;
  streetId?: string;
  streetName?: string;
  buildingNo?: string;
  apartmentNo?: string;
  staircaseId?: string;
  staircase?: string;
  entranceId?: string;
  entrance?: string;
  flatLabel?: string;
};

export type InvoiceAddressMatch = {
  streetName: string;
  streetId?: string;
  buildingNo: string;
  apartmentNo: string;
  flatId: string;
  confidence: number;
  reason: string;
};

function normalize(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bul\.?\b/g, " ")
    .replace(/\bal\.?\b/g, " ")
    .replace(/\bos\.?\b/g, " ")
    .replace(/[^a-z0-9/ -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: unknown) {
  return normalize(value).split(/[\s/,-]+/).filter(Boolean);
}

function uniq(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function safeString(value: unknown) {
  return String(value ?? "").trim();
}

function parseAddressHints(text: string) {
  const raw = safeString(text);
  const normalized = normalize(raw);
  const out = { streetName: "", buildingNo: "", apartmentNo: "", staircaseId: "" };
  const streetMatch = raw.match(/(?:ul(?:ica)?|al(?:eja)?|os(?:iedle)?)\.?\s+([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż .-]{3,})/i);
  if (streetMatch?.[1]) out.streetName = safeString(streetMatch[1]).split(/\s+(?:nr|bud|budynku|lok|lokalu|kl|klatka)\b/i)[0] || "";
  const addressMatch = normalized.match(/([a-ząćęłńóśźż .-]{3,})\s+(\d+[a-z]?)(?:\/(\d+[a-z]?))?/i);
  if (!out.streetName && addressMatch?.[1]) out.streetName = safeString(addressMatch[1]);
  if (addressMatch?.[2]) out.buildingNo = safeString(addressMatch[2]);
  if (addressMatch?.[3]) out.apartmentNo = safeString(addressMatch[3]);
  const buildingMatch = raw.match(/(?:bud(?:ynek|ynku)?|nr\s+budynku|adres\s+obiektu|adres\s+dostawy|punkt\s+poboru)\s*[:#-]?\s*(\d+[A-Za-z]?)/i);
  if (buildingMatch?.[1] && !out.buildingNo) out.buildingNo = safeString(buildingMatch[1]);
  const apartmentMatch = raw.match(/(?:lokal(?:u)?|mieszkanie|nr\s+lokalu|lok\.)\s*[:#-]?\s*(\d+[A-Za-z]?)/i);
  if (apartmentMatch?.[1]) out.apartmentNo = safeString(apartmentMatch[1]);
  const stairMatch = raw.match(/(?:klatka|kl\.|staircase|entrance|pion)\s*[:#-]?\s*([A-Za-z0-9-]+)/i);
  if (stairMatch?.[1]) out.staircaseId = safeString(stairMatch[1]);
  return out;
}

export function inferCostScope(text: string) {
  const raw = safeString(text);
  const t = normalize(raw);
  const hints = parseAddressHints(raw);
  const reasons: string[] = [];
  const explicitFlatNo = !!hints.apartmentNo || /(?:nr\s+lokalu|lokal(?:u)?|mieszkanie|adres\s+lokalu|\/\d+[a-z]?)/i.test(raw);
  const communityScore = /(?:cala?\s+wspolnot|wszystkie\s+budynki|cale\s+osiedle|osiedl|wspolnota\s+mieszkaniow|zarzad\s+wspolnoty)/.test(t) ? 1 : 0;
  const commonScore = /(?:czesc\s+wspoln|czesci\s+wspoln|nieruchomosc\s+wspoln|fundusz\s+remontowy|sprzatanie\s+klatek|oswietlenie\s+klatki|pion\s+wentylacyjny|pion\s+kanal|winda|teren\s+wspoln|garaz\s+wspoln)/.test(t) ? 1 : 0;
  const staircaseScore = /(?:klatka|kl\.|staircase|entrance|pion)/.test(t) ? 1 : 0;
  const buildingScore = /(?:budynek|adres\s+obiektu|adres\s+dostawy|punkt\s+poboru|obiekt)/.test(t) ? 1 : 0;
  const flatScore = /(?:lokal(?:u)?|mieszkanie|nr\s+lokalu|adres\s+lokalu|odbiorca\s+uslugi)/.test(t) ? 1 : 0;

  if (communityScore) {
    reasons.push("tekst wskazuje na koszt całej wspólnoty / osiedla");
    return { scope: "COMMUNITY" as const, confidence: 0.94, reason: reasons.join("; ") };
  }
  if (commonScore && staircaseScore && hints.staircaseId) {
    reasons.push("tekst wskazuje na część wspólną klatki / pionu");
    return { scope: "COMMON" as const, confidence: 0.92, reason: reasons.join("; ") };
  }
  if (commonScore && (buildingScore || hints.buildingNo)) {
    reasons.push("tekst wskazuje na część wspólną budynku");
    return { scope: "COMMON" as const, confidence: 0.9, reason: reasons.join("; ") };
  }
  if (commonScore) {
    reasons.push("tekst wskazuje na koszt części wspólnej");
    return { scope: "COMMON" as const, confidence: 0.88, reason: reasons.join("; ") };
  }
  if (staircaseScore && hints.staircaseId && !explicitFlatNo) {
    reasons.push("tekst wskazuje na konkretną klatkę / pion");
    return { scope: "STAIRCASE" as const, confidence: 0.86, reason: reasons.join("; ") };
  }
  if (buildingScore && !explicitFlatNo) {
    reasons.push("tekst wskazuje na konkretny budynek");
    return { scope: "BUILDING" as const, confidence: 0.82, reason: reasons.join("; ") };
  }
  if (flatScore && explicitFlatNo) {
    reasons.push("tekst zawiera jednoznaczny numer lokalu");
    return { scope: "FLAT" as const, confidence: 0.84, reason: reasons.join("; ") };
  }
  if (explicitFlatNo && !commonScore && !communityScore) {
    reasons.push("rozpoznano numer lokalu w adresie");
    return { scope: "FLAT" as const, confidence: 0.8, reason: reasons.join("; ") };
  }
  if (hints.buildingNo) {
    reasons.push("rozpoznano adres budynku");
    return { scope: "BUILDING" as const, confidence: 0.66, reason: reasons.join("; ") };
  }
  return { scope: "UNKNOWN" as const, confidence: 0.3, reason: "brak jednoznacznego typu kosztu" };
}

export function matchInvoiceAddress(text: string, flats: FlatCandidate[]): InvoiceAddressMatch | null {
  const normalized = normalize(text);
  if (!normalized || !flats.length) return null;
  let best: InvoiceAddressMatch | null = null;

  for (const flat of flats) {
    const streetName = String(flat.street || flat.streetName || "").trim();
    const buildingNo = String(flat.buildingNo || "").trim();
    const apartmentNo = String(flat.apartmentNo || "").trim();
    const label = String(flat.flatLabel || buildFlatLabel(streetName, buildingNo, apartmentNo)).trim();
    if (!streetName || !buildingNo) continue;

    const streetTokens = uniq(tokenize(streetName)).filter((x) => x.length >= 3);
    let score = 0;
    const reasons: string[] = [];

    if (streetTokens.length && streetTokens.every((token) => normalized.includes(token))) {
      score += 0.45;
      reasons.push("rozpoznano ulicę");
    } else if (streetTokens.some((token) => normalized.includes(token))) {
      score += 0.2;
      reasons.push("częściowo rozpoznano ulicę");
    }

    const streetAndBuilding = `${normalize(streetName)} ${buildingNo.toLowerCase()}`.trim();
    if (streetAndBuilding && normalized.includes(streetAndBuilding)) {
      score += 0.24;
      reasons.push("rozpoznano numer budynku");
    } else if (buildingNo && new RegExp(`(^|[^0-9])${buildingNo.toLowerCase()}([^0-9]|$)`).test(normalized)) {
      score += 0.14;
      reasons.push("znaleziono możliwy numer budynku");
    }

    if (apartmentNo) {
      const aptPatterns = [
        `${buildingNo.toLowerCase()}/${apartmentNo.toLowerCase()}`,
        `lokal ${apartmentNo.toLowerCase()}`,
        `nr lokalu ${apartmentNo.toLowerCase()}`,
        `mieszkanie ${apartmentNo.toLowerCase()}`,
        `/${apartmentNo.toLowerCase()}`,
      ];
      if (aptPatterns.some((pattern) => normalized.includes(pattern))) {
        score += 0.24;
        reasons.push("rozpoznano numer lokalu");
      }
    }

    if (label && normalized.includes(normalize(label))) {
      score += 0.15;
      reasons.push("rozpoznano pełny adres lokalu");
    }

    if (!best || score > best.confidence) {
      best = {
        streetName,
        streetId: flat.streetId,
        buildingNo,
        apartmentNo,
        flatId: flat.id,
        confidence: Math.min(0.96, score),
        reason: reasons.join(", ") || "dopasowanie słabe",
      };
    }
  }

  return best && best.confidence >= 0.45 ? best : null;
}
