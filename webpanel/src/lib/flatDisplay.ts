import { buildFlatLabel } from "./flatMapping";

function pick(...values: any[]) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function parseAddressFromLabel(flatLabel: any) {
  const raw = String(flatLabel || "").trim();
  if (!raw || /^\d+[a-zA-Z]?$/.test(raw)) return { street: "", buildingNo: "", apartmentNo: raw };
  const slash = raw.match(/^(.*?)(?:\s+)?(\d+[\w-]*)\/(\d+[\w-]*)$/);
  if (slash) return { street: String(slash[1] || "").trim(), buildingNo: String(slash[2] || "").trim(), apartmentNo: String(slash[3] || "").trim() };
  return { street: "", buildingNo: "", apartmentNo: "" };
}

export function getFlatStreet(flat: any) {
  const parsed = parseAddressFromLabel(flat?.flatLabel || flat?.addressLabel);
  return pick(flat?.street, flat?.streetName, flat?.streetLabel, flat?.addressStreet, flat?.payerStreet, flat?.residentStreet, parsed.street);
}

export function getFlatBuildingNo(flat: any) {
  const parsed = parseAddressFromLabel(flat?.flatLabel || flat?.addressLabel);
  return pick(flat?.buildingNo, flat?.buildingId, flat?.buildingNumber, flat?.houseNo, flat?.payerBuildingNo, flat?.residentBuildingNo, parsed.buildingNo);
}

export function getFlatApartmentNo(flat: any) {
  const parsed = parseAddressFromLabel(flat?.flatLabel || flat?.addressLabel);
  return pick(flat?.apartmentNo, flat?.flatNumber, flat?.apartmentNumber, flat?.localNo, flat?.unitNo, flat?.payerApartmentNo, flat?.residentApartmentNo, parsed.apartmentNo);
}

export function getFlatDisplayLabel(flat: any) {
  const explicit = pick(flat?.addressLabel);
  if (explicit) return explicit;
  const street = getFlatStreet(flat);
  const buildingNo = getFlatBuildingNo(flat);
  const apartmentNo = getFlatApartmentNo(flat);
  const built = buildFlatLabel(street, buildingNo, apartmentNo);
  const flatLabel = String(flat?.flatLabel || "").trim();
  if (built) return built;
  if (flatLabel) return flatLabel;
  if (apartmentNo) return apartmentNo;
  return pick(flat?.id, "—");
}

export function getFlatResidentName(flat: any) {
  return pick(
    flat?.residentName,
    flat?.displayName,
    [flat?.name || flat?.firstName, flat?.surname || flat?.lastName].filter(Boolean).join(" "),
    [flat?.residentFirstName, flat?.residentLastName].filter(Boolean).join(" "),
    flat?.payerName,
    flat?.tenantName,
  );
}

export function getFlatEmail(flat: any) {
  return pick(flat?.email, flat?.residentEmail, flat?.payerEmail, flat?.mail, flat?.userEmail);
}

export function getFlatPhone(flat: any) {
  return pick(flat?.phone, flat?.residentPhone, flat?.payerPhone, flat?.mobile, flat?.tel, flat?.userPhone);
}
