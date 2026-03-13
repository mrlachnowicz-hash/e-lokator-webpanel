const crypto = require("node:crypto");
const admin = require("firebase-admin");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");

setGlobalOptions({ region: "europe-west1" });

try {
  admin.app();
} catch (e) {
  admin.initializeApp();
}

const db = admin.firestore();
const bucket = admin.storage().bucket();
const { FieldValue } = admin.firestore;

const OWNER_UIDS = ["C4NPiqCNCChdDZ0s54di5g8Mt5l2"];
const OWNER_EMAILS = ["mrlachnowicz@gmail.com"];
let openAiClient = null;

function nowMs() {
  return Date.now();
}

function requireAuth(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Zaloguj się.");
  }
  return request.auth.uid;
}

async function getMyProfile(uid) {
  const snap = await db.doc(`users/${uid}`).get();
  return snap.exists ? snap.data() : null;
}

async function requireCommunityStaff(request, communityId) {
  const uid = requireAuth(request);
  const profile = await getMyProfile(uid);
  const role = String(profile?.role || "");
  const ok = ["MASTER", "ADMIN", "ACCOUNTANT"].includes(role) && profileCommunityId(profile) === safeText(communityId);
  if (!ok) throw new HttpsError("permission-denied", "Brak uprawnień do tej wspólnoty.");
  return { uid, profile };
}

async function getCommunity(communityId) {
  if (!safeText(communityId)) return null;
  const snap = await db.doc(`communities/${communityId}`).get();
  return snap.exists ? snap.data() : null;
}

async function assertPanelAccessEnabled(communityId) {
  const community = await getCommunity(communityId);
  if (!community || communityPanelEnabledValue(community) !== true) {
    throw new HttpsError("permission-denied", "Panel nie jest aktywny dla tej wspólnoty.");
  }
  return community;
}


async function requireCommunityRole(request, communityId, allowedRoles) {
  const uid = requireAuth(request);
  const profile = await getMyProfile(uid);
  const role = String(profile?.role || "");
  const ok = Array.isArray(allowedRoles) && allowedRoles.includes(role) && profileCommunityId(profile) === safeText(communityId);
  if (!ok) throw new HttpsError("permission-denied", "Brak uprawnień do tej operacji.");
  return { uid, profile, role };
}

async function upsertFlatWithSeat({ communityId, flatId = "", staircaseId = "", streetId = "", street = "", buildingNo = "", apartmentNo = "", flatLabel = "", flatKey = "", residentUid = null, extra = {}, payer = null }) {
  if (!safeText(communityId)) throw new HttpsError("invalid-argument", "Brak communityId.");
  if (!safeText(apartmentNo)) throw new HttpsError("invalid-argument", "Brak numeru lokalu.");
  const flatsCol = db.collection("communities").doc(communityId).collection("flats");
  const normalizedStreet = safeText(street);
  const normalizedBuilding = safeText(buildingNo);
  const normalizedApartment = safeText(apartmentNo);
  const computedKey = safeText(flatKey) || buildFlatKey(communityId, normalizedStreet, normalizedBuilding, normalizedApartment);
  let existing = null;
  if (safeText(flatId)) {
    const byId = await flatsCol.doc(safeText(flatId)).get();
    if (byId.exists) existing = byId;
  }
  if (!existing && computedKey) {
    const byKey = await flatsCol.where("flatKey", "==", computedKey).limit(1).get();
    if (!byKey.empty) existing = byKey.docs[0];
  }
  if (!existing && normalizedStreet && normalizedBuilding && normalizedApartment) {
    const byAddress = await flatsCol
      .where("street", "==", normalizedStreet)
      .where("buildingNo", "==", normalizedBuilding)
      .where("apartmentNo", "==", normalizedApartment)
      .limit(1)
      .get();
    if (!byAddress.empty) existing = byAddress.docs[0];
  }

  const targetRef = existing ? existing.ref : (safeText(flatId) ? flatsCol.doc(safeText(flatId)) : flatsCol.doc());
  const now = nowMs();
  const communityRef = db.doc(`communities/${communityId}`);
  const payerRef = db.doc(`communities/${communityId}/payers/${targetRef.id}`);

  return db.runTransaction(async (tx) => {
    const communitySnap = await tx.get(communityRef);
    if (!communitySnap.exists) throw new HttpsError("not-found", "Wspólnota nie istnieje.");
    const targetSnap = await tx.get(targetRef);
    const exists = targetSnap.exists;
    const current = exists ? targetSnap.data() : {};
    const payerSnap = payer ? await tx.get(payerRef) : null;
    if (!exists) {
      const communityData = communitySnap.data() || {};
      const seatsTotal = communitySeatsTotalValue(communityData);
      const seatsUsed = communitySeatsUsedValue(communityData);
      if (seatsUsed >= seatsTotal) {
        throw new HttpsError("failed-precondition", "Brak wolnych seats. Dokup i zatwierdź seats w generatorze ownera.");
      }
      tx.set(communityRef, { ...seatUsedPatch(seatsUsed + 1), updatedAtMs: now }, { merge: true });
    }

    const mergedStreet = safeText(normalizedStreet || current.street);
    const mergedBuilding = safeText(normalizedBuilding || current.buildingNo);
    const mergedApartment = safeText(normalizedApartment || current.apartmentNo || current.flatNumber);
    const finalKey = safeText(computedKey || current.flatKey || buildFlatKey(communityId, mergedStreet, mergedBuilding, mergedApartment));
    const finalLabel = safeText(flatLabel || current.flatLabel || makeFlatLabel(mergedStreet, mergedBuilding, mergedApartment) || mergedApartment);

    const payload = {
      communityId,
      staircaseId: safeText(staircaseId || current.staircaseId),
      streetId: safeText(streetId || current.streetId),
      street: mergedStreet,
      buildingNo: mergedBuilding,
      apartmentNo: mergedApartment,
      flatNumber: safeText(extra.flatNumber || mergedApartment || current.flatNumber),
      flatLabel: finalLabel,
      flatKey: finalKey,
      residentUid: residentUid === null ? (current.residentUid || null) : residentUid,
      updatedAtMs: now,
      createdAtMs: Number(current.createdAtMs || now),
      ...extra,
    };
    tx.set(targetRef, payload, { merge: true });

    if (payer) {
      tx.set(payerRef, {
        flatId: targetRef.id,
        communityId,
        streetId: safeText(streetId || payer.streetId || current.streetId),
        street: mergedStreet,
        buildingNo: mergedBuilding,
        apartmentNo: mergedApartment,
        flatLabel: finalLabel,
        flatKey: finalKey,
        name: safeText(payer.name),
        surname: safeText(payer.surname),
        email: safeText(payer.email),
        phone: safeText(payer.phone),
        mailOnly: !!payer.mailOnly,
        updatedAtMs: now,
        createdAtMs: Number(payerSnap?.data()?.createdAtMs || now),
      }, { merge: true });
    }

    return {
      flatId: targetRef.id,
      created: !exists,
      seatsUsed: exists ? communitySeatsUsedValue(communitySnap.data() || {}) : communitySeatsUsedValue(communitySnap.data() || {}) + 1,
      seatsTotal: communitySeatsTotalValue(communitySnap.data() || {}),
    };
  });
}

function assertOwner(request) {
  const uid = requireAuth(request);
  const token = request.auth.token || {};
  const email = String(token.email || "");
  const ok = token.owner === true || OWNER_UIDS.includes(uid) || OWNER_EMAILS.includes(email);
  if (!ok) throw new HttpsError("permission-denied", "Brak uprawnień Ownera.");
}

function randomCode(len = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return out;
}

function safeText(v, fallback = "") {
  return String(v == null ? fallback : v).trim();
}

function boolValue(value, fallback = false) {
  if (value === true || value === false) return value;
  if (typeof value === "number") return value !== 0;
  const text = safeText(value).toLowerCase();
  if (!text) return fallback;
  return ["1", "true", "yes", "y", "on", "enabled", "active"].includes(text);
}

function intValue(value, fallback = 0) {
  if (value == null) return fallback;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  const normalized = safeText(value).replace(/[^\d-]/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function normalizeEmail(value) {
  return safeText(value).toLowerCase();
}

function profileCommunityId(profile) {
  return safeText(
    profile?.communityId ||
    profile?.customerId ||
    profile?.activeCommunityId ||
    profile?.currentCommunityId ||
    profile?.selectedCommunityId
  );
}

function communityPanelEnabledValue(community) {
  const values = [
    community?.panelAccessEnabled,
    community?.accessToPanel,
    community?.panelActive,
    community?.panelEnabled,
    community?.webpanelEnabled,
    community?.webPanelEnabled,
  ];
  const first = values.find((value) => value !== undefined && value !== null);
  return boolValue(first, false);
}

function communityBlockedValue(community) {
  const values = [
    community?.blocked,
    community?.isBlocked,
    community?.appBlocked,
  ];
  const first = values.find((value) => value !== undefined && value !== null);
  if (first !== undefined) return boolValue(first, false);
  return safeText(community?.status).toUpperCase() === "BLOCKED";
}

function communitySeatsTotalValue(community) {
  return Math.max(
    intValue(community?.seatsTotal, 0),
    intValue(community?.appSeatsTotal, 0),
    intValue(community?.panelSeats, 0),
    intValue(community?.panelSeatsLimit, 0),
    intValue(community?.seats, 0),
    intValue(community?.seatsLimit, 0),
    intValue(community?.totalSeats, 0),
    intValue(community?.maxSeats, 0),
    intValue(community?.purchasedSeats, 0),
    intValue(community?.seatsPurchased, 0),
    intValue(community?.flatsLimit, 0),
    intValue(community?.localsLimit, 0),
    intValue(community?.localiLimit, 0),
    intValue(community?.unitsLimit, 0),
    intValue(community?.licenses, 0),
    intValue(community?.seatCount, 0)
  );
}

function communitySeatsUsedValue(community, fallback = 0) {
  return Math.max(
    intValue(fallback, 0),
    intValue(community?.seatsUsed, 0),
    intValue(community?.panelSeatsUsed, 0),
    intValue(community?.appSeatsUsed, 0),
    intValue(community?.occupiedSeats, 0),
    intValue(community?.residentCount, 0),
    intValue(community?.usersCount, 0)
  );
}

function futureYearMs(baseMs = nowMs()) {
  return Number(baseMs) + 365 * 24 * 60 * 60 * 1000;
}

function seatTotalPatch(total) {
  const seats = intValue(total, 0);
  return {
    seatsTotal: seats,
    appSeatsTotal: seats,
    panelSeats: seats,
    panelSeatsLimit: seats,
    seats: seats,
    seatsLimit: seats,
    totalSeats: seats,
    maxSeats: seats,
    purchasedSeats: seats,
    seatsPurchased: seats,
    flatsLimit: seats,
    localsLimit: seats,
    localiLimit: seats,
    unitsLimit: seats,
    licenses: seats,
    seatCount: seats,
  };
}

function seatUsedPatch(used) {
  const seats = intValue(used, 0);
  return {
    seatsUsed: seats,
    panelSeatsUsed: seats,
    appSeatsUsed: seats,
    occupiedSeats: seats,
    residentCount: seats,
    usersCount: seats,
  };
}

function panelPatch(enabled) {
  const value = enabled === true;
  return {
    panelAccessEnabled: value,
    accessToPanel: value,
    panelActive: value,
    panelEnabled: value,
    webpanelEnabled: value,
    webPanelEnabled: value,
  };
}

function blockedPatch(blocked) {
  const value = blocked === true;
  return {
    blocked: value,
    isBlocked: value,
    appBlocked: value,
    status: value ? "BLOCKED" : "ACTIVE",
    active: !value,
    enabled: !value,
  };
}

function normalizeStreetName(name) {
  return safeText(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hashText(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex");
}

function getOpenAiClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!openAiClient) {
    const { OpenAI } = require("openai");
    openAiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openAiClient;
}

function parsePeriod(input) {
  const raw = safeText(input);
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function periodToDueDateMs(period) {
  if (!/^\d{4}-\d{2}$/.test(period)) return 0;
  const [year, month] = period.split("-").map(Number);
  return Date.UTC(year, month - 1, 15, 12, 0, 0, 0);
}

function monthTitle(period) {
  const names = ["Styczeń", "Luty", "Marzec", "Kwiecień", "Maj", "Czerwiec", "Lipiec", "Sierpień", "Wrzesień", "Październik", "Listopad", "Grudzień"];
  if (!/^\d{4}-\d{2}$/.test(period)) return period || "Rozliczenie";
  const [y, m] = period.split("-");
  return `${names[Number(m) - 1] || period} ${y}`;
}

function parseAmountToCents(value) {
  if (typeof value === "number") return Math.round(value * 100);
  const txt = safeText(value).replace(/\s/g, "").replace(/,/g, ".").replace(/[^0-9.-]/g, "");
  const num = Number(txt);
  return Number.isFinite(num) ? Math.round(num * 100) : 0;
}

function paymentCodeFromText(text) {
  const m = safeText(text).match(/EL-(\d+)/i);
  return m ? m[1] : null;
}

function sanitizeEmail(email) {
  const e = safeText(email).toLowerCase();
  return e.includes("@") ? e : "";
}


function normalizeFlatPart(value) {
  return safeText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9_-]/g, "");
}

function buildFlatKey(communityId, street, buildingNo, apartmentNo) {
  const parts = [communityId, street, buildingNo, apartmentNo].map(normalizeFlatPart).filter(Boolean);
  return parts.join("|");
}

function makeFlatLabel(street, buildingNo, apartmentNo) {
  const base = [safeText(street), safeText(buildingNo)].filter(Boolean).join(" ");
  const apt = safeText(apartmentNo);
  return apt ? `${base}/${apt}`.trim() : base;
}

async function findFlatByKeyOrAddress(communityId, { flatId = "", flatKey = "", street = "", buildingNo = "", apartmentNo = "" } = {}) {
  const flatsCol = db.collection("communities").doc(communityId).collection("flats");
  if (safeText(flatId)) {
    const snap = await flatsCol.doc(safeText(flatId)).get();
    if (snap.exists) return snap;
  }
  const normalizedKey = safeText(flatKey) || buildFlatKey(communityId, street, buildingNo, apartmentNo);
  if (normalizedKey) {
    const byKey = await flatsCol.where("flatKey", "==", normalizedKey).limit(1).get();
    if (!byKey.empty) return byKey.docs[0];
  }
  if (safeText(street) && safeText(buildingNo) && safeText(apartmentNo)) {
    const byAddress = await flatsCol
      .where("street", "==", safeText(street))
      .where("buildingNo", "==", safeText(buildingNo))
      .where("apartmentNo", "==", safeText(apartmentNo))
      .limit(1)
      .get();
    if (!byAddress.empty) return byAddress.docs[0];
  }
  return null;
}

async function claimOrCreateFlatForResident({ communityId, uid, flatId = "", flatKey = "", street = "", buildingNo = "", apartmentNo = "", flatLabel = "", staircaseId = "" }) {
  const result = await upsertFlatWithSeat({
    communityId,
    flatId,
    staircaseId,
    street,
    buildingNo,
    apartmentNo,
    flatLabel,
    flatKey,
    residentUid: uid,
  });
  const targetRef = db.collection("communities").doc(communityId).collection("flats").doc(result.flatId);
  const snap = await targetRef.get();
  const data = snap.data() || {};
  await targetRef.set({
    occupantsUids: FieldValue.arrayUnion(uid),
    status: "ACTIVE",
    updatedAtMs: nowMs(),
  }, { merge: true });
  return {
    flatId: targetRef.id,
    flatLabel: safeText(data.flatLabel),
    street: safeText(data.street),
    buildingNo: safeText(data.buildingNo),
    apartmentNo: safeText(data.apartmentNo),
    staircaseId: safeText(data.staircaseId),
    flatKey: safeText(data.flatKey),
    residentUid: uid,
  };
}

function normalizeCategory(input) {
  const txt = safeText(input).toUpperCase();
  if (!txt) return "INNE";
  const map = {
    ENERGIA: "PRAD",
    PRĄD: "PRAD",
    PRAD: "PRAD",
    WODA: "WODA",
    GAZ: "GAZ",
    CIEPLO: "CIEPLO",
    CIEPŁO: "CIEPLO",
    REMONT: "REMONT",
    SPRZATANIE: "SPRZATANIE",
    SPRZĄTANIE: "SPRZATANIE",
  };
  return map[txt] || txt;
}

async function getInvoiceRules(communityId) {
  const snap = await db.collection("communities").doc(communityId).collection("invoiceRules").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function findRuleMatch(communityId, invoice) {
  const rules = await getInvoiceRules(communityId);
  const source = `${safeText(invoice?.vendorName)} ${safeText(invoice?.title)} ${safeText(invoice?.description)}`.toUpperCase();
  return rules.find((r) => {
    const needle = safeText(r.match || r.vendor || r.keyword).toUpperCase();
    return needle && source.includes(needle);
  }) || null;
}

async function sumCollection(query) {
  const snap = await query.get();
  return snap.docs.reduce((acc, d) => acc + Number(d.get("amountCents") || 0), 0);
}

async function getSettlementData(communityId, flatId, period) {
  const chargesQ = db.collection("communities").doc(communityId).collection("charges").where("flatId", "==", flatId).where("period", "==", period);
  const paymentsQ = db.collection("communities").doc(communityId).collection("payments").where("flatId", "==", flatId).where("period", "==", period);
  const [chargesSnap, paymentsSnap] = await Promise.all([chargesQ.get(), paymentsQ.get()]);
  const charges = chargesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const payments = paymentsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const chargesCents = charges.reduce((a, x) => a + Number(x.amountCents || 0), 0);
  const paymentsCents = payments.reduce((a, x) => a + Number(x.amountCents || 0), 0);
  return { charges, payments, chargesCents, paymentsCents, balanceCents: chargesCents - paymentsCents };
}

function pdfEscape(text) {
  return safeText(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildSimplePdf(lines) {
  const contentLines = [];
  let y = 790;
  contentLines.push("BT");
  contentLines.push("/F1 10 Tf");
  for (const line of lines.slice(0, 55)) {
    contentLines.push(`1 0 0 1 50 ${y} Tm (${pdfEscape(line).slice(0, 110)}) Tj`);
    y -= 14;
  }
  contentLines.push("ET");
  const stream = contentLines.join("\n");
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    `5 0 obj << /Length ${Buffer.byteLength(stream, "utf8")} >> stream\n${stream}\nendstream endobj`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${obj}\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

async function uploadSettlementPdf(communityId, settlementId, data) {
  const lines = [
    "e-Lokator — Rozliczenie",
    `Okres: ${data.period}`,
    `Lokal: ${data.flatId}`,
    `Suma opłat: ${(data.chargesCents / 100).toFixed(2)} PLN`,
    `Suma wpłat: ${(data.paymentsCents / 100).toFixed(2)} PLN`,
    `Saldo: ${(data.balanceCents / 100).toFixed(2)} PLN`,
    `Termin płatności: ${data.dueDate || "-"}`,
    `Rachunek: ${data.accountNumber || "-"}`,
    `Tytuł przelewu: ${data.transferTitle || "-"}`,
    "",
    "Opłaty:",
    ...data.charges.map((x) => `- ${safeText(x.label || x.category)}: ${(Number(x.amountCents || 0) / 100).toFixed(2)} PLN`),
    "",
    "Wpłaty:",
    ...data.payments.map((x) => `- ${safeText(x.title || x.source || "Wpłata")}: ${(Number(x.amountCents || 0) / 100).toFixed(2)} PLN`),
  ];
  const buffer = buildSimplePdf(lines);
  const path = `communities/${communityId}/settlements/${settlementId}.pdf`;
  const file = bucket.file(path);
  await file.save(buffer, { contentType: "application/pdf", resumable: false, metadata: { cacheControl: "public,max-age=3600" } });
  const [url] = await file.getSignedUrl({ action: "read", expires: "2100-01-01" });
  return { path, url };
}

async function refreshBalanceDoc(communityId, flatId) {
  const chargesQ = db.collection("communities").doc(communityId).collection("charges").where("flatId", "==", flatId);
  const paymentsQ = db.collection("communities").doc(communityId).collection("payments").where("flatId", "==", flatId);
  const [chargesCents, paymentsCents] = await Promise.all([sumCollection(chargesQ), sumCollection(paymentsQ)]);
  const balanceCents = chargesCents - paymentsCents;
  await db.collection("communities").doc(communityId).collection("balances").doc(flatId).set({
    flatId,
    chargesCents,
    paymentsCents,
    balanceCents,
    updatedAtMs: nowMs(),
  }, { merge: true });
  return { chargesCents, paymentsCents, balanceCents };
}

async function getCommunityAdmins(communityId) {
  const users = await listCommunityUsersByAliases(communityId);
  return users
    .map((doc) => doc.data())
    .filter((data) => ["ADMIN", "MASTER", "ACCOUNTANT"].includes(safeText(data?.role).toUpperCase()))
    .map((data) => safeText(data?.fcmToken))
    .filter(Boolean);
}

async function getUserToken(uid) {
  if (!uid) return null;
  const snap = await db.doc(`users/${uid}`).get();
  return snap.exists ? snap.data().fcmToken : null;
}

async function getResidentTokensForFlat(communityId, flatId) {
  if (!communityId || !flatId) return [];
  const snap = await db.collection("users")
    .where("communityId", "==", communityId)
    .where("flatId", "==", flatId)
    .where("role", "==", "RESIDENT")
    .get();
  return snap.docs.map((d) => d.data().fcmToken).filter(Boolean);
}

function normalizeForMatch(value) {
  return safeText(value)
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function extractFlatHints(text) {
  const src = normalizeForMatch(text);
  const hints = new Set();
  if (!src) return [];
  const patterns = [
    /(?:LOKAL|MIESZKANIE|M\.?|NR|NUMER)\s*([A-Z0-9\/-]{1,12})/g,
    /\b([0-9]{1,4}[A-Z]?)\b/g,
  ];
  patterns.forEach((re) => {
    let m;
    while ((m = re.exec(src)) !== null) {
      const v = safeText(m[1]).toUpperCase();
      if (v) hints.add(v);
    }
  });
  return [...hints];
}

function scorePaymentToFlat(rowText, flat, amountCents) {
  const hay = normalizeForMatch(rowText);
  if (!hay) return 0;
  let score = 0;
  const addIfContains = (val, pts) => {
    const token = normalizeForMatch(val);
    if (token && hay.includes(token)) score += pts;
  };
  addIfContains(flat.flatNumber, 70);
  addIfContains(flat.apartmentNo, 70);
  addIfContains(flat.localNumber, 70);
  addIfContains(flat.flatLabel, 45);
  addIfContains(flat.street, 15);
  addIfContains(flat.buildingNo, 20);
  addIfContains(flat.name, 35);
  addIfContains(flat.surname, 35);
  addIfContains(flat.email, 20);
  if (Array.isArray(flat.aliases)) {
    flat.aliases.forEach((x) => addIfContains(x, 25));
  }
  const hints = extractFlatHints(rowText);
  if (hints.some((x) => [flat.flatNumber, flat.apartmentNo, flat.localNumber].map((v) => safeText(v).toUpperCase()).includes(x))) {
    score += 45;
  }
  if (amountCents > 0 && Number(flat.lastKnownBalanceCents || 0) > 0) {
    const diff = Math.abs(Number(flat.lastKnownBalanceCents || 0) - amountCents);
    if (diff <= 50) score += 10;
  }
  return score;
}

async function fuzzyFindFlatForPayment(communityId, row) {
  const title = safeText(row.title || row.description || row.tytul || row.tytuł || row.opis);
  const source = safeText(row.source || row.bank || row.konto);
  const code = safeText(row.code);
  const rowText = `${title} ${source} ${code}`;
  const amountCents = parseAmountToCents(row.amount ?? row.kwota);
  const flatsSnap = await db.collection('communities').doc(communityId).collection('flats').get();
  let best = null;
  for (const doc of flatsSnap.docs) {
    const data = doc.data() || {};
    const score = scorePaymentToFlat(rowText, data, amountCents);
    if (!best || score > best.score) best = { doc, score };
  }
  return best && best.score >= 70 ? best.doc : null;
}

async function listCommunityUsersByAliases(communityId) {
  const [communityUsersSnap, customerUsersSnap] = await Promise.all([
    db.collection("users").where("communityId", "==", communityId).get().catch(() => null),
    db.collection("users").where("customerId", "==", communityId).get().catch(() => null),
  ]);
  const merged = new Map();
  [communityUsersSnap, customerUsersSnap].forEach((snap) => {
    snap?.docs?.forEach((doc) => {
      if (!merged.has(doc.id)) merged.set(doc.id, { uid: doc.id, ...doc.data() });
    });
  });
  return Array.from(merged.values());
}

async function countCommunitySeatsUsed(communityId) {
  const [payersSnap, flatsSnap, users] = await Promise.all([
    db.collection(`communities/${communityId}/payers`).get().catch(() => null),
    db.collection(`communities/${communityId}/flats`).get().catch(() => null),
    listCommunityUsersByAliases(communityId).catch(() => []),
  ]);
  const visibleUsers = users.filter((user) => {
    const role = safeText(user.role).toUpperCase();
    if (["REMOVED", "DELETED"].includes(role)) return false;
    if (user.deleted === true) return false;
    return true;
  }).length;
  return Math.max(payersSnap?.size || 0, flatsSnap?.size || 0, visibleUsers, 0);
}

async function calculateSeatsTotalFromPurchases(communityId, fallbackTotal = 0) {
  const snap = await db.collection(`communities/${communityId}/seat_purchases`).get().catch(() => null);
  if (!snap || snap.empty) return intValue(fallbackTotal, 0);
  const now = nowMs();
  let total = 0;
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const seats = intValue(data.seats, 0);
    const blocked = boolValue(data.blocked, false);
    const validUntilMs = intValue(data.validUntilMs, 0);
    if (seats <= 0 || blocked) continue;
    if (validUntilMs > 0 && validUntilMs < now) continue;
    total += seats;
  }
  return total;
}

async function syncCommunityDoc(communityId, overrides = {}) {
  const ref = db.doc(`communities/${communityId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Wspolnota nie istnieje.");
  const current = snap.data() || {};
  const seatsTotal = overrides.seatsTotal != null ?
    intValue(overrides.seatsTotal, 0) :
    await calculateSeatsTotalFromPurchases(communityId, communitySeatsTotalValue(current));
  const seatsUsed = overrides.seatsUsed != null ?
    intValue(overrides.seatsUsed, 0) :
    await countCommunitySeatsUsed(communityId);
  const panelEnabled = overrides.panelAccessEnabled != null ?
    overrides.panelAccessEnabled === true :
    communityPanelEnabledValue(current);
  const blocked = overrides.blocked != null ?
    overrides.blocked === true :
    communityBlockedValue(current);

  const patch = {
    id: communityId,
    ownerEmail: normalizeEmail(overrides.ownerEmail || current.ownerEmail),
    masterEmail: normalizeEmail(overrides.masterEmail || current.masterEmail),
    updatedAtMs: nowMs(),
    ...seatTotalPatch(seatsTotal),
    ...seatUsedPatch(seatsUsed),
    ...panelPatch(panelEnabled),
    ...blockedPatch(blocked),
  };

  if (Array.isArray(overrides.streetRegistry)) {
    patch.streetIds = overrides.streetRegistry.map((street) => safeText(street.id)).filter(Boolean);
    patch.streetNames = overrides.streetRegistry.map((street) => safeText(street.name)).filter(Boolean);
    patch.streetsList = overrides.streetRegistry
      .map((street) => ({ id: safeText(street.id), name: safeText(street.name) }))
      .filter((street) => street.id && street.name);
  }

  if (overrides.deleted != null) {
    patch.deleted = overrides.deleted === true;
    if (patch.deleted) patch.deletedAtMs = nowMs();
  }

  await ref.set(patch, { merge: true });
  return {
    communityId,
    seatsTotal,
    seatsUsed,
    panelAccessEnabled: panelEnabled,
    blocked,
    streetCount: Array.isArray(patch.streetIds) ? patch.streetIds.length : undefined,
  };
}

function shadowUserId(communityId, flatId) {
  return `payer_${communityId}_${flatId}`;
}

function legacyShadowUserId(communityId, flatId) {
  return `shadow_${communityId}_${flatId}`;
}

async function repairCommunityData(communityId) {
  const [payersSnap, streetsSnap, assignmentsSnap, flatsSnap, users] = await Promise.all([
    db.collection(`communities/${communityId}/payers`).get().catch(() => null),
    db.collection(`communities/${communityId}/streets`).get().catch(() => null),
    db.collection(`communities/${communityId}/streetAssignments`).get().catch(() => null),
    db.collection(`communities/${communityId}/flats`).get().catch(() => null),
    listCommunityUsersByAliases(communityId).catch(() => []),
  ]);

  const usersByEmail = new Map();
  users.forEach((user) => {
    const email = normalizeEmail(user.email);
    const role = safeText(user.role).toUpperCase();
    if (!email) return;
    if (user.isShadow === true || user.placeholderResident === true) return;
    if (["REMOVED", "DELETED"].includes(role)) return;
    if (!usersByEmail.has(email)) usersByEmail.set(email, user);
  });

  let payerCount = 0;
  let shadowCreated = 0;
  let payerLinked = 0;

  for (const payerDoc of payersSnap?.docs || []) {
    payerCount += 1;
    const payer = payerDoc.data() || {};
    const flatId = safeText(payer.flatId || payerDoc.id);
    if (!flatId) continue;
    const linked = normalizeEmail(payer.email) ? usersByEmail.get(normalizeEmail(payer.email)) : null;
    const residentUid = safeText(payer.residentUid || payer.userId || linked?.uid);
    const flatRef = db.doc(`communities/${communityId}/flats/${flatId}`);

    if (linked?.uid) {
      await Promise.all([
        db.doc(`communities/${communityId}/payers/${payerDoc.id}`).set({
          residentUid: linked.uid,
          userId: linked.uid,
          mailOnly: false,
          updatedAtMs: nowMs(),
        }, { merge: true }),
        flatRef.set({
          residentUid: linked.uid,
          userId: linked.uid,
          occupantsUids: FieldValue.arrayUnion(linked.uid),
          flatLabel: safeText(payer.flatLabel),
          flatKey: safeText(payer.flatKey),
          status: "ACTIVE",
          updatedAtMs: nowMs(),
        }, { merge: true }),
        db.doc(`users/${linked.uid}`).set({
          communityId,
          customerId: communityId,
          activeCommunityId: communityId,
          currentCommunityId: communityId,
          selectedCommunityId: communityId,
          flatId,
          street: safeText(linked.street || payer.street),
          streetId: safeText(linked.streetId || payer.streetId),
          buildingNo: safeText(linked.buildingNo || payer.buildingNo),
          apartmentNo: safeText(linked.apartmentNo || payer.apartmentNo || payer.flatNumber),
          flatLabel: safeText(linked.flatLabel || payer.flatLabel),
          updatedAtMs: nowMs(),
        }, { merge: true }),
      ]);
      await db.doc(`users/${shadowUserId(communityId, flatId)}`).delete().catch(() => null);
      await db.doc(`users/${legacyShadowUserId(communityId, flatId)}`).delete().catch(() => null);
      payerLinked += 1;
      continue;
    }

    if (!residentUid) {
      const placeholderUid = shadowUserId(communityId, flatId);
      const placeholderRef = db.doc(`users/${placeholderUid}`);
      const placeholderSnap = await placeholderRef.get().catch(() => null);
      await Promise.all([
        placeholderRef.set({
          uid: placeholderUid,
          communityId,
          customerId: communityId,
          activeCommunityId: communityId,
          currentCommunityId: communityId,
          selectedCommunityId: communityId,
          flatId,
          role: "RESIDENT",
          displayName: safeText(payer.displayName || `${safeText(payer.name)} ${safeText(payer.surname)}`).trim(),
          firstName: safeText(payer.name),
          lastName: safeText(payer.surname),
          name: safeText(payer.name),
          surname: safeText(payer.surname),
          email: safeText(payer.email),
          emailLower: normalizeEmail(payer.email),
          phone: safeText(payer.phone),
          street: safeText(payer.street),
          streetId: safeText(payer.streetId),
          buildingNo: safeText(payer.buildingNo),
          apartmentNo: safeText(payer.apartmentNo || payer.flatNumber),
          flatLabel: safeText(payer.flatLabel),
          flatKey: safeText(payer.flatKey),
          mailOnly: false,
          placeholderResident: true,
          isShadow: true,
          authLinked: false,
          active: false,
          appVisible: false,
          source: "WEBPANEL_PLACEHOLDER",
          createdAtMs: Number(payer.createdAtMs || nowMs()),
          updatedAtMs: nowMs(),
        }, { merge: true }),
        db.doc(`communities/${communityId}/payers/${payerDoc.id}`).set({
          residentUid: placeholderUid,
          userId: placeholderUid,
          updatedAtMs: nowMs(),
        }, { merge: true }),
        flatRef.set({
          residentUid: placeholderUid,
          userId: placeholderUid,
          flatLabel: safeText(payer.flatLabel),
          flatKey: safeText(payer.flatKey),
          updatedAtMs: nowMs(),
        }, { merge: true }),
      ]);
      await db.doc(`users/${legacyShadowUserId(communityId, flatId)}`).delete().catch(() => null);
      if (!placeholderSnap?.exists) shadowCreated += 1;
    }
  }

  const streetMap = new Map();
  const registerStreet = (idCandidate, nameCandidate) => {
    const name = safeText(nameCandidate);
    const id = safeText(idCandidate || normalizeStreetName(name));
    if (!id || !name) return;
    streetMap.set(id, { id, name });
  };

  for (const doc of streetsSnap?.docs || []) {
    const data = doc.data() || {};
    registerStreet(doc.id || data.id, data.name || data.street);
  }
  for (const doc of assignmentsSnap?.docs || []) {
    const data = doc.data() || {};
    registerStreet(data.id || doc.id, data.name || data.street || data.streetName);
  }
  for (const doc of flatsSnap?.docs || []) {
    const data = doc.data() || {};
    registerStreet(data.streetId, data.street);
  }

  await Promise.all(Array.from(streetMap.values()).map((street) => Promise.all([
    db.doc(`communities/${communityId}/streets/${street.id}`).set({
      id: street.id,
      communityId,
      name: street.name,
      normalizedName: street.id,
      isActive: true,
      updatedAtMs: nowMs(),
      createdAtMs: nowMs(),
    }, { merge: true }),
    db.doc(`communities/${communityId}/streetAssignments/${street.id}`).set({
      id: street.id,
      communityId,
      street: street.name,
      streetName: street.name,
      name: street.name,
      isActive: true,
      updatedAtMs: nowMs(),
    }, { merge: true }),
  ])));

  const sync = await syncCommunityDoc(communityId, {
    seatsUsed: Math.max(payerCount, users.length, flatsSnap?.size || 0),
    streetRegistry: Array.from(streetMap.values()),
  });

  return {
    ...sync,
    payerCount,
    shadowCreated,
    payerLinked,
    streetCount: streetMap.size,
  };
}

function sanitizeHtmlToText(html) {
  return safeText(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|p|div|li|section|article|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function detectAiCategory(text) {
  const hay = safeText(text).toLowerCase();
  if (/awari|przerw|usterk|brak wody|brak pradu|zalan/.test(hay)) return "AWARIE";
  if (/oplata|czynsz|platn|rachunk|rozliczen/.test(hay)) return "OPLATY";
  if (/ostrzez|uwaga|zagrozen|alarm|pilne/.test(hay)) return "OSTRZEZENIA";
  if (/wydarzen|spotkan|zebran|festyn|piknik|warsztat/.test(hay)) return "WYDARZENIA";
  return "ADMINISTRACJA";
}

function detectAiPriority(text) {
  const hay = safeText(text).toLowerCase();
  if (/pilne|natychmiast|awari|ostrzez|uwaga/.test(hay)) return "HIGH";
  if (/wazne|termin|oplata|czynsz|zebran/.test(hay)) return "MEDIUM";
  return "LOW";
}

function extractAiNewsCandidates(text, maxItems = 5) {
  const items = [];
  const seen = new Set();
  const paragraphs = safeText(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 40);
  for (const paragraph of paragraphs) {
    const normalized = paragraph.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    items.push(paragraph);
    if (items.length >= maxItems) break;
  }
  if (!items.length && safeText(text)) items.push(safeText(text).slice(0, 400));
  return items;
}

async function summarizeAiCandidate(source, candidate) {
  const client = getOpenAiClient();
  const text = safeText(candidate).slice(0, 2400);
  if (client) {
    try {
      const response = await client.responses.create({
        model: process.env.COMMUNITY_AI_MODEL || "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: "Summarize community notices for residents. Return JSON with title, summary, importance and category. Keep it short and practical.",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({
                  sourceName: safeText(source.name),
                  sourceCategory: safeText(source.category),
                  text,
                }),
              },
            ],
          },
        ],
      });
      const outputText = safeText(response.output_text);
      const parsed = JSON.parse(outputText);
      return {
        title: safeText(parsed.title).slice(0, 120),
        aiSummary: safeText(parsed.summary).slice(0, 500),
        priority: ["HIGH", "MEDIUM", "LOW"].includes(safeText(parsed.importance).toUpperCase()) ? safeText(parsed.importance).toUpperCase() : detectAiPriority(text),
        category: safeText(parsed.category).toUpperCase() || detectAiCategory(text),
      };
    } catch (_) {}
  }
  const firstSentence = safeText(text.split(/[.!?]\s+/)[0]).slice(0, 120);
  return {
    title: firstSentence || safeText(source.name) || "Wspolnota AI",
    aiSummary: safeText(text).slice(0, 400),
    priority: detectAiPriority(text),
    category: detectAiCategory(text),
  };
}

async function publishAiItemAsAnnouncement(communityId, item, actorUid = "") {
  const ref = db.collection(`communities/${communityId}/announcements`).doc();
  await ref.set({
    title: item.title,
    body: item.aiSummary,
    communityId,
    source: "COMMUNITY_AI",
    aiNewsId: item.id,
    aiSourceId: item.sourceId,
    createdAtMs: nowMs(),
    createdByUid: actorUid,
    importance: item.priority,
    category: item.category,
  }, { merge: true });
  return ref.id;
}

async function refreshAiSourceInternal(communityId, sourceId, actorUid = "", options = {}) {
  const sourceRef = db.doc(`communities/${communityId}/aiSources/${sourceId}`);
  const sourceSnap = await sourceRef.get();
  if (!sourceSnap.exists) throw new HttpsError("not-found", "Zrodlo AI nie istnieje.");
  const source = { id: sourceSnap.id, ...sourceSnap.data() };
  if (source.enabled === false && options.force !== true) {
    return { sourceId, skipped: true, reason: "disabled" };
  }

  let response;
  try {
    response = await fetch(safeText(source.url), {
      headers: { "user-agent": "e-lokator-community-ai/1.0" },
    });
  } catch (error) {
    await sourceRef.set({ lastRefreshAtMs: nowMs(), lastError: safeText(error?.message || "fetch_failed"), updatedAtMs: nowMs() }, { merge: true });
    throw new HttpsError("unavailable", "Nie udalo sie pobrac zrodla AI.");
  }

  if (!response.ok) {
    await sourceRef.set({ lastRefreshAtMs: nowMs(), lastError: `http_${response.status}`, updatedAtMs: nowMs() }, { merge: true });
    throw new HttpsError("failed-precondition", "Zrodlo AI zwrocilo blad HTTP.");
  }

  const html = await response.text();
  const cleanText = sanitizeHtmlToText(html);
  const candidates = extractAiNewsCandidates(cleanText, 5);
  let created = 0;

  for (const candidate of candidates) {
    const summary = await summarizeAiCandidate(source, candidate);
    const sourceHash = hashText(`${safeText(source.url)}|${safeText(candidate)}`);
    const newsRef = db.doc(`communities/${communityId}/aiNews/${sourceHash}`);
    const existing = await newsRef.get();
    if (existing.exists && options.force !== true) continue;

    const payload = {
      id: sourceHash,
      communityId,
      sourceId,
      sourceName: safeText(source.name),
      sourceCategory: safeText(source.category),
      sourceUrl: safeText(source.url),
      title: safeText(summary.title),
      aiSummary: safeText(summary.aiSummary),
      sourceExcerpt: safeText(candidate).slice(0, 1200),
      category: safeText(summary.category || detectAiCategory(candidate)),
      priority: safeText(summary.priority || detectAiPriority(candidate)),
      important: safeText(summary.priority).toUpperCase() === "HIGH",
      pinned: false,
      hidden: false,
      archived: false,
      publishedAsAnnouncement: false,
      contentHash: sourceHash,
      fetchedAtMs: nowMs(),
      updatedAtMs: nowMs(),
      createdAtMs: existing.exists ? Number(existing.data()?.createdAtMs || nowMs()) : nowMs(),
      createdByUid: actorUid,
    };

    await newsRef.set(payload, { merge: true });
    if (source.publishAsAnnouncement === true && payload.priority === "HIGH") {
      const announcementId = await publishAiItemAsAnnouncement(communityId, payload, actorUid).catch(() => "");
      if (announcementId) {
        await newsRef.set({ publishedAsAnnouncement: true, announcementId, updatedAtMs: nowMs() }, { merge: true });
      }
    }
    created += 1;
  }

  await sourceRef.set({
    lastRefreshAtMs: nowMs(),
    lastError: "",
    lastStatus: "OK",
    lastItemsCount: candidates.length,
    updatedAtMs: nowMs(),
    updatedByUid: actorUid,
  }, { merge: true });

  return { sourceId, created, processed: candidates.length };
}

async function sendToToken(token, type, title, body, extraData = {}) {
  if (!token) return;
  await admin.messaging().send({ token, data: { type, title, body, ...Object.fromEntries(Object.entries(extraData).map(([k, v]) => [k, String(v)])) }, android: { priority: "high" } }).catch((e) => console.error("FCM error", e));
}

async function sendToTokens(tokens, type, title, body, extraData = {}) {
  if (!tokens || !tokens.length) return;
  await admin.messaging().sendEachForMulticast({ tokens, data: { type, title, body, ...Object.fromEntries(Object.entries(extraData).map(([k, v]) => [k, String(v)])) } }).catch((e) => console.error("FCM multicast error", e));
}

exports.onAnnouncementCreated = onDocumentCreated("communities/{communityId}/announcements/{announcementId}", async (event) => {
  const data = event.data.data();
  await admin.messaging().send({ topic: `community_${event.params.communityId}`, data: { type: "announcement_admin", title: "Ogłoszenie administracji", body: safeText(data.title), senderUid: safeText(data.createdByUid) } }).catch(() => null);
});

exports.onResidentAnnouncementCreated = onDocumentCreated("communities/{communityId}/residentAnnouncements/{announcementId}", async (event) => {
  const data = event.data.data();
  await admin.messaging().send({ topic: `community_${event.params.communityId}`, data: { type: "announcement_new", title: "Nowe ogłoszenie lokatorskie", body: safeText(data.title), senderUid: safeText(data.createdByUid) } }).catch(() => null);
});

exports.onChatMessageCreated = onDocumentCreated("communities/{communityId}/chatMessages/{messageId}", async (event) => {
  const data = event.data.data();
  await admin.messaging().send({ topic: `community_${event.params.communityId}`, data: { type: "community_chat", title: safeText(data.senderName, "Wiadomość"), body: safeText(data.text), senderUid: safeText(data.senderUid) } }).catch(() => null);
});

exports.onTicketCreated = onDocumentCreated("communities/{communityId}/tickets/{ticketId}", async (event) => {
  const data = event.data.data();
  const adminTokens = await getCommunityAdmins(event.params.communityId);
  await sendToTokens(adminTokens, "ticket_new", "Nowa usterka", `${safeText(data.flatLabel)}: ${safeText(data.title)}`, { senderUid: safeText(data.createdByUid) });
});

exports.onTicketUpdated = onDocumentUpdated("communities/{communityId}/tickets/{ticketId}", async (event) => {
  const after = event.data.after.data();
  const before = event.data.before.data();
  if (safeText(after.status) !== safeText(before.status)) {
    const token = await getUserToken(after.createdByUid);
    await sendToToken(token, "ticket_status", "Zmiana statusu usterki", `${safeText(after.title)}: ${safeText(after.status)}`, { senderUid: safeText(after.updatedByUid) });
  }
});

exports.onVoteCreated = onDocumentCreated("communities/{communityId}/votes/{voteId}", async (event) => {
  const data = event.data.data();
  await admin.messaging().send({ topic: `community_${event.params.communityId}`, data: { type: "vote_new", title: "Nowe głosowanie", body: safeText(data.title), senderUid: safeText(data.createdByUid) } }).catch(() => null);
});

exports.onCorrespondenceMessageCreated = onDocumentCreated("communities/{communityId}/correspondence/{resUid}/messages/{msgId}", async (event) => {
  const data = event.data.data();
  const resUid = event.params.resUid;
  if (safeText(data.senderUid) === safeText(resUid)) {
    const adminTokens = await getCommunityAdmins(event.params.communityId);
    await sendToTokens(adminTokens, "correspondence", "Wiadomość od lokatora", safeText(data.text), { senderUid: safeText(data.senderUid) });
  } else {
    const token = await getUserToken(resUid);
    await sendToToken(token, "correspondence", "Wiadomość od administracji", safeText(data.text), { senderUid: safeText(data.senderUid) });
  }
});

exports.onSettlementCreated = onDocumentCreated("communities/{communityId}/settlements/{settlementId}", async (event) => {
  const data = event.data.data() || {};
  const flatId = safeText(data.flatId);
  const tokens = await getResidentTokensForFlat(event.params.communityId, flatId);
  await sendToTokens(tokens, "due_created", "Nowe rozliczenie", safeText(data.title || `Rozliczenie za ${data.period || ''}`), {
    settlementId: event.params.settlementId,
    flatId,
    period: safeText(data.period),
  });
});

exports.onSettlementUpdated = onDocumentUpdated("communities/{communityId}/settlements/{settlementId}", async (event) => {
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};
  const changed = Number(before.balanceCents || 0) !== Number(after.balanceCents || 0) ||
    Number(before.chargesCents || 0) !== Number(after.chargesCents || 0) ||
    Number(before.paymentsCents || 0) !== Number(after.paymentsCents || 0) ||
    safeText(before.pdfUrl) !== safeText(after.pdfUrl);
  if (!changed) return;
  const flatId = safeText(after.flatId);
  const tokens = await getResidentTokensForFlat(event.params.communityId, flatId);
  await sendToTokens(tokens, "due_created", "Aktualizacja rozliczenia", safeText(after.title || `Rozliczenie za ${after.period || ''}`), {
    settlementId: event.params.settlementId,
    flatId,
    period: safeText(after.period),
  });
});

exports.createActivationCode = onCall(async (request) => {
  assertOwner(request);
  const name = safeText(request.data?.name || request.data?.orgName);
  const nip = safeText(request.data?.nip).replace(/\D/g, "");
  const initialSeats = Math.max(intValue(request.data?.initialSeats, 2), 1);
  if (!name || nip.length !== 10) throw new HttpsError("invalid-argument", "Podaj nazwę i poprawny NIP.");
  for (let i = 0; i < 10; i++) {
    const code = randomCode(10);
    const ref = db.doc(`activation_codes/${code}`);
    try {
      await ref.create({
        code,
        name,
        nip,
        initialSeats,
        seatsTotal: initialSeats,
        panelAccessEnabled: true,
        blocked: false,
        used: false,
        status: "ACTIVE",
        createdAtMs: nowMs(),
        createdByUid: request.auth.uid,
        createdByEmail: normalizeEmail(request.auth?.token?.email),
      });
      return { code, docPath: ref.path, initialSeats };
    } catch (e) {
      if (e.code !== 6) throw e;
    }
  }
  throw new HttpsError("resource-exhausted", "Błąd generowania kodu.");
});

exports.createInvite = onCall(async (request) => {
  const uid = requireAuth(request);
  const me = await getMyProfile(uid);
  const communityId = safeText(request.data?.communityId || profileCommunityId(me));
  const role = safeText(request.data?.role || "RESIDENT");
  const invite = {
    customerId: me?.customerId || me?.communityId || communityId,
    communityId,
    role,
    status: "active",
    invitedByUid: uid,
    createdAtMs: nowMs(),
    expiresAtMs: Number(request.data?.expiresAtMs || nowMs() + 7 * 24 * 3600 * 1000),
    staircaseId: safeText(request.data?.staircaseId),
    flatId: safeText(request.data?.flatId),
    flatLabel: safeText(request.data?.flatLabel),
    street: safeText(request.data?.street),
    buildingNo: safeText(request.data?.buildingNo),
    apartmentNo: safeText(request.data?.apartmentNo),
    flatKey: safeText(request.data?.flatKey) || buildFlatKey(communityId, request.data?.street, request.data?.buildingNo, request.data?.apartmentNo),
    adminFullName: safeText(request.data?.adminFullName),
    adminPhone: safeText(request.data?.adminPhone),
    senderName: safeText(request.data?.senderName),
    companyName: safeText(request.data?.companyName),
    nip: safeText(request.data?.nip),
    industry: safeText(request.data?.industry),
  };
  const ref = await db.collection("invites").add(invite);
  const activeInviteDocId = role === "ADMIN" ? "last_admin_invite" : (invite.flatId ? `flat_${invite.flatId}` : "");
  if (activeInviteDocId) {
    await db.doc(`communities/${communityId}/activeInvites/${activeInviteDocId}`).set({
      inviteId: ref.id,
      role,
      flatId: invite.flatId,
      communityId,
      expiresAtMs: invite.expiresAtMs,
      updatedAtMs: nowMs(),
    }, { merge: true });
  }
  return { inviteId: ref.id };
});

exports.claimInvite = onCall(async (request) => {
  const uid = requireAuth(request);
  const inviteId = safeText(request.data?.inviteId);
  if (!inviteId) throw new HttpsError("invalid-argument", "Brak inviteId.");
  const requestStreet = safeText(request.data?.street);
  const requestBuildingNo = safeText(request.data?.buildingNo);
  const requestApartmentNo = safeText(request.data?.apartmentNo);
  const senderName = safeText(request.data?.name);
  const inviteRef = db.doc(`invites/${inviteId}`);
  const snap = await inviteRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Invite nie istnieje.");
  const inv = snap.data();
  if (safeText(inv.status).toLowerCase() === "revoked") throw new HttpsError("failed-precondition", "Invite zostal odwolany.");
  if (Number(inv.expiresAtMs || 0) > 0 && Number(inv.expiresAtMs || 0) < nowMs()) throw new HttpsError("deadline-exceeded", "Invite wygasl.");
  const communityId = safeText(inv.communityId);
  const role = safeText(inv.role || "RESIDENT");
  let flat = null;
  if (role === "RESIDENT" && communityId) {
    flat = await claimOrCreateFlatForResident({
      communityId,
      uid,
      flatId: safeText(inv.flatId),
      flatKey: safeText(inv.flatKey),
      street: requestStreet || safeText(inv.street),
      buildingNo: requestBuildingNo || safeText(inv.buildingNo),
      apartmentNo: requestApartmentNo || safeText(inv.apartmentNo),
      flatLabel: safeText(inv.flatLabel),
      staircaseId: safeText(inv.staircaseId),
    });
  }
  await db.doc(`users/${uid}`).set({
    role,
    communityId,
    customerId: inv.customerId || communityId,
    activeCommunityId: communityId,
    currentCommunityId: communityId,
    selectedCommunityId: communityId,
    displayName: senderName || undefined,
    street: flat?.street || requestStreet || safeText(inv.street),
    buildingNo: flat?.buildingNo || requestBuildingNo || safeText(inv.buildingNo),
    apartmentNo: flat?.apartmentNo || requestApartmentNo || safeText(inv.apartmentNo),
    flatId: flat?.flatId || safeText(inv.flatId) || undefined,
    staircaseId: flat?.staircaseId || safeText(inv.staircaseId) || undefined,
    flatLabel: flat?.flatLabel || safeText(inv.flatLabel) || undefined,
    updatedAtMs: nowMs(),
  }, { merge: true });
  await inviteRef.set({ status: "used", usedByUid: uid, usedAtMs: nowMs() }, { merge: true });
  return { ok: true, flatId: flat?.flatId || null, flatLabel: flat?.flatLabel || null };
});


exports.upsertFlat = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  await requireCommunityRole(request, communityId, ["MASTER", "ACCOUNTANT", "ADMIN"]);
  const profile = await getMyProfile(requireAuth(request));
  const role = String(profile?.role || "");
  const panelFlow = request.data?.source === "WEBPANEL";
  if (panelFlow) {
    await assertPanelAccessEnabled(communityId);
    if (!["MASTER", "ACCOUNTANT"].includes(role)) {
      throw new HttpsError("permission-denied", "Administrator nie ma dostępu do webpanelu.");
    }
  }
  return await upsertFlatWithSeat({
    communityId,
    flatId: safeText(request.data?.flatId),
    staircaseId: safeText(request.data?.staircaseId),
    streetId: safeText(request.data?.streetId),
    street: safeText(request.data?.street),
    buildingNo: safeText(request.data?.buildingNo),
    apartmentNo: safeText(request.data?.apartmentNo),
    flatLabel: safeText(request.data?.flatLabel),
    flatKey: safeText(request.data?.flatKey),
    extra: {
      name: safeText(request.data?.name),
      surname: safeText(request.data?.surname),
      email: safeText(request.data?.email),
      phone: safeText(request.data?.phone),
      areaM2: request.data?.areaM2 == null || request.data?.areaM2 === "" ? null : Number(request.data?.areaM2),
      flatNumber: safeText(request.data?.flatNumber || request.data?.apartmentNo),
    },
    payer: request.data?.withPayer ? {
      streetId: safeText(request.data?.streetId),
      name: safeText(request.data?.name),
      surname: safeText(request.data?.surname),
      email: safeText(request.data?.email),
      phone: safeText(request.data?.phone),
      mailOnly: !!request.data?.email && !safeText(request.data?.phone),
    } : null,
  });
});

exports.importFlats = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  const rows = Array.isArray(request.data?.rows) ? request.data.rows : [];
  await requireCommunityRole(request, communityId, ["MASTER", "ACCOUNTANT"]);
  await assertPanelAccessEnabled(communityId);
  let created = 0;
  let updated = 0;
  const results = [];
  for (const row of rows) {
    const apartmentNo = safeText(row.apartmentNo || row.flatNumber);
    if (!apartmentNo) continue;
    const res = await upsertFlatWithSeat({
      communityId,
      streetId: safeText(row.streetId),
      street: safeText(row.street),
      buildingNo: safeText(row.buildingNo),
      apartmentNo,
      flatLabel: safeText(row.flatLabel),
      flatKey: safeText(row.flatKey),
      extra: {
        flatNumber: apartmentNo,
        name: safeText(row.name),
        surname: safeText(row.surname),
        email: safeText(row.email),
        phone: safeText(row.phone),
        areaM2: row.areaM2 == null || row.areaM2 === "" ? null : Number(row.areaM2),
      },
      payer: {
        streetId: safeText(row.streetId),
        name: safeText(row.name),
        surname: safeText(row.surname),
        email: safeText(row.email),
        phone: safeText(row.phone),
        mailOnly: !!safeText(row.email) && !safeText(row.phone),
      },
    });
    if (res.created) created += 1; else updated += 1;
    results.push(res);
  }
  return { ok: true, created, updated, results };
});

exports.activateCommunity = onCall(async (request) => {
  const uid = requireAuth(request);
  const code = safeText(request.data?.code).toUpperCase();
  if (!code) throw new HttpsError("invalid-argument", "Brak kodu aktywacyjnego.");
  const communityDoc = db.collection("communities").doc();
  const activationRef = db.doc(`activation_codes/${code}`);
  const initialPurchaseRef = communityDoc.collection("seat_purchases").doc("activation");
  return db.runTransaction(async (tx) => {
    const codeSnap = await tx.get(activationRef);
    if (!codeSnap.exists) throw new HttpsError("not-found", "Kod nie istnieje.");
    const codeData = codeSnap.data() || {};
    const status = safeText(codeData.status).toUpperCase();
    if (codeData.used === true || status === "USED") throw new HttpsError("failed-precondition", "Kod zostal juz uzyty.");
    if (status && status !== "ACTIVE") throw new HttpsError("failed-precondition", "Kod nie jest aktywny.");

    const name = safeText(request.data?.name || codeData.name);
    const nip = safeText(request.data?.nip || codeData.nip).replace(/\D/g, "");
    const initialSeats = Math.max(
      intValue(request.data?.initialSeats, 0) ||
      intValue(codeData.initialSeats, 0) ||
      intValue(codeData.seatsTotal, 0),
      1
    );
    if (!name || nip.length !== 10) throw new HttpsError("invalid-argument", "Brak danych aktywacji.");

    const email = normalizeEmail(request.auth?.token?.email);
    const now = nowMs();

    tx.set(communityDoc, {
      id: communityDoc.id,
      name,
      nip,
      createdAtMs: now,
      updatedAtMs: now,
      ownerEmail: normalizeEmail(codeData.createdByEmail || codeData.ownerEmail),
      masterEmail: email,
      enableExternalPayments: false,
      paymentsUrl: "",
      ...panelPatch(true),
      ...blockedPatch(false),
      ...seatTotalPatch(initialSeats),
      ...seatUsedPatch(0),
    }, { merge: true });
    tx.set(initialPurchaseRef, {
      id: "activation",
      seats: initialSeats,
      purchasedAtMs: now,
      validUntilMs: futureYearMs(now),
      blocked: false,
      source: "ACTIVATION",
      createdAtMs: now,
      updatedAtMs: now,
    }, { merge: true });
    tx.set(db.doc(`users/${uid}`), {
      role: "MASTER",
      communityId: communityDoc.id,
      customerId: communityDoc.id,
      activeCommunityId: communityDoc.id,
      currentCommunityId: communityDoc.id,
      selectedCommunityId: communityDoc.id,
      email,
      updatedAtMs: now,
    }, { merge: true });
    tx.set(activationRef, {
      used: true,
      status: "USED",
      usedAtMs: now,
      usedByUid: uid,
      usedByEmail: email,
      communityId: communityDoc.id,
      updatedAtMs: now,
    }, { merge: true });
    return { communityId: communityDoc.id, seatsTotal: initialSeats };
  });
});

exports.disableActivationCode = onCall(async (request) => {
  assertOwner(request);
  const code = safeText(request.data?.code).toUpperCase();
  if (!code) throw new HttpsError("invalid-argument", "Brak kodu.");
  const ref = db.doc(`activation_codes/${code}`);
  await ref.set({
    status: "DISABLED",
    disabledAtMs: nowMs(),
    disabledByUid: request.auth?.uid || "",
    updatedAtMs: nowMs(),
  }, { merge: true });
  return { ok: true, code };
});

exports.ownerSetCommunityBlocked = onCall(async (request) => {
  assertOwner(request);
  const communityId = safeText(request.data?.communityId);
  if (!communityId) throw new HttpsError("invalid-argument", "Brak communityId.");
  return { ok: true, ...(await syncCommunityDoc(communityId, { blocked: request.data?.blocked === true })) };
});

exports.ownerSetCommunityPanelAccess = onCall(async (request) => {
  assertOwner(request);
  const communityId = safeText(request.data?.communityId);
  if (!communityId) throw new HttpsError("invalid-argument", "Brak communityId.");
  return { ok: true, ...(await syncCommunityDoc(communityId, { panelAccessEnabled: request.data?.enabled === true })) };
});

exports.ownerApproveSeatRequest = onCall(async (request) => {
  assertOwner(request);
  const requestId = safeText(request.data?.requestId);
  const communityId = safeText(request.data?.communityId);
  const deltaSeats = Math.max(intValue(request.data?.deltaSeats, 0), 0);
  if (!requestId || !communityId || deltaSeats <= 0) throw new HttpsError("invalid-argument", "Brak danych do zatwierdzenia.");

  const reqRef = db.doc(`seat_requests/${requestId}`);
  const commRef = db.doc(`communities/${communityId}`);
  const purchaseRef = commRef.collection("seat_purchases").doc();
  await db.runTransaction(async (tx) => {
    const [reqSnap, commSnap] = await Promise.all([tx.get(reqRef), tx.get(commRef)]);
    if (!reqSnap.exists) throw new HttpsError("not-found", "Prosba nie istnieje.");
    if (!commSnap.exists) throw new HttpsError("not-found", "Wspolnota nie istnieje.");
    const reqData = reqSnap.data() || {};
    if (safeText(reqData.status).toUpperCase() === "APPROVED") return;
    const now = nowMs();
    tx.set(purchaseRef, {
      id: purchaseRef.id,
      seats: deltaSeats,
      purchasedAtMs: now,
      validUntilMs: futureYearMs(now),
      blocked: false,
      source: "OWNER_APPROVAL",
      requestId,
      createdAtMs: now,
      createdByUid: request.auth?.uid || "",
      updatedAtMs: now,
    }, { merge: true });
    tx.set(reqRef, {
      status: "APPROVED",
      processedAtMs: now,
      processedByUid: request.auth?.uid || "",
      updatedAtMs: now,
    }, { merge: true });
  });
  return { ok: true, requestId, ...(await syncCommunityDoc(communityId)) };
});

exports.ownerRejectSeatRequest = onCall(async (request) => {
  assertOwner(request);
  const requestId = safeText(request.data?.requestId);
  if (!requestId) throw new HttpsError("invalid-argument", "Brak requestId.");
  await db.doc(`seat_requests/${requestId}`).set({
    status: "REJECTED",
    processedAtMs: nowMs(),
    processedByUid: request.auth?.uid || "",
    updatedAtMs: nowMs(),
  }, { merge: true });
  return { ok: true, requestId };
});

exports.ownerExtendSeatPurchase = onCall(async (request) => {
  assertOwner(request);
  const communityId = safeText(request.data?.communityId);
  const purchaseId = safeText(request.data?.purchaseId);
  if (!communityId || !purchaseId) throw new HttpsError("invalid-argument", "Brak danych zakupu.");
  const ref = db.doc(`communities/${communityId}/seat_purchases/${purchaseId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Zakup nie istnieje.");
    const current = intValue(snap.data()?.validUntilMs, 0);
    tx.set(ref, {
      validUntilMs: futureYearMs(Math.max(current, nowMs())),
      updatedAtMs: nowMs(),
    }, { merge: true });
  });
  return { ok: true, ...(await syncCommunityDoc(communityId)) };
});

exports.ownerSetSeatPurchaseBlocked = onCall(async (request) => {
  assertOwner(request);
  const communityId = safeText(request.data?.communityId);
  const purchaseId = safeText(request.data?.purchaseId);
  if (!communityId || !purchaseId) throw new HttpsError("invalid-argument", "Brak danych zakupu.");
  await db.doc(`communities/${communityId}/seat_purchases/${purchaseId}`).set({
    blocked: request.data?.blocked === true,
    updatedAtMs: nowMs(),
  }, { merge: true });
  return { ok: true, ...(await syncCommunityDoc(communityId)) };
});

exports.ownerDeleteCommunity = onCall(async (request) => {
  assertOwner(request);
  const communityId = safeText(request.data?.communityId);
  if (!communityId) throw new HttpsError("invalid-argument", "Brak communityId.");
  return { ok: true, ...(await syncCommunityDoc(communityId, { blocked: true, panelAccessEnabled: false, deleted: true })) };
});

exports.ownerRepairCommunity = onCall(async (request) => {
  assertOwner(request);
  const communityId = safeText(request.data?.communityId);
  if (!communityId) throw new HttpsError("invalid-argument", "Brak communityId.");
  return { ok: true, ...(await repairCommunityData(communityId)) };
});

exports.repairCommunitySync = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  if (!communityId) throw new HttpsError("invalid-argument", "Brak communityId.");
  await requireCommunityRole(request, communityId, ["MASTER", "ADMIN", "ACCOUNTANT"]);
  return { ok: true, ...(await repairCommunityData(communityId)) };
});

exports.revokeInvite = onCall(async (request) => {
  const uid = requireAuth(request);
  const inviteId = safeText(request.data?.inviteId);
  if (!inviteId) throw new HttpsError("invalid-argument", "Brak inviteId.");
  const me = await getMyProfile(uid);
  const snap = await db.doc(`invites/${inviteId}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "Invite nie istnieje.");
  const invite = snap.data() || {};
  const communityId = safeText(invite.communityId);
  const myRole = safeText(me?.role);
  const sameCommunity = profileCommunityId(me) === communityId;
  const isOwner = request.auth?.token?.owner === true || OWNER_UIDS.includes(uid) || OWNER_EMAILS.includes(normalizeEmail(request.auth?.token?.email));
  if (!isOwner && !(sameCommunity && ["MASTER", "ADMIN"].includes(myRole))) {
    throw new HttpsError("permission-denied", "Brak uprawnien do odwolania invite.");
  }
  await db.doc(`invites/${inviteId}`).set({
    status: "revoked",
    revokedAtMs: nowMs(),
    revokedByUid: uid,
    updatedAtMs: nowMs(),
  }, { merge: true });
  const activeInviteDocId = safeText(invite.role).toUpperCase() === "ADMIN" ? "last_admin_invite" : (safeText(invite.flatId) ? `flat_${safeText(invite.flatId)}` : "");
  if (activeInviteDocId) {
    await db.doc(`communities/${communityId}/activeInvites/${activeInviteDocId}`).delete().catch(() => null);
  }
  return { ok: true, inviteId };
});

exports.consumeWebSession = onCall(async (request) => {
  assertOwner(request);
  const token = safeText(request.data?.token);
  if (!token) throw new HttpsError("invalid-argument", "Brak tokenu.");
  const ref = db.doc(`webSessions/${token}`);
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Token nie istnieje.");
    const data = snap.data() || {};
    if (data.used === true) throw new HttpsError("failed-precondition", "Token juz wykorzystany.");
    if (Number(data.expiresAtMs || 0) < nowMs()) throw new HttpsError("deadline-exceeded", "Token wygasl.");
    tx.set(ref, { used: true, usedAtMs: nowMs(), updatedAtMs: nowMs() }, { merge: true });
    return { ok: true, uid: safeText(data.uid), communityId: safeText(data.communityId), target: safeText(data.target || "/dashboard") };
  });
});

exports.moderateChatMessage = onCall(async (request) => {
  const uid = requireAuth(request);
  const communityId = safeText(request.data?.communityId);
  const messageId = safeText(request.data?.messageId);
  if (!communityId || !messageId) throw new HttpsError("invalid-argument", "Brak communityId lub messageId.");
  const actor = await getMyProfile(uid);
  const actorRole = safeText(actor?.role);
  const messageRef = db.doc(`communities/${communityId}/chatMessages/${messageId}`);
  const messageSnap = await messageRef.get();
  if (!messageSnap.exists) throw new HttpsError("not-found", "Wiadomosc nie istnieje.");
  const message = messageSnap.data() || {};
  const isAuthor = safeText(message.senderUid) === uid;
  const isStaff = profileCommunityId(actor) === communityId && ["MASTER", "ADMIN", "ACCOUNTANT"].includes(actorRole);
  if (!isAuthor && !isStaff) throw new HttpsError("permission-denied", "Brak uprawnien do moderacji tej wiadomosci.");
  await messageRef.set({
    deleted: request.data?.deleted !== false,
    deletedAtMs: nowMs(),
    deletedByUid: uid,
    moderationReason: safeText(request.data?.reason),
    updatedAtMs: nowMs(),
  }, { merge: true });
  return { ok: true, messageId };
});

exports.clearCommunityChat = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  if (!communityId) throw new HttpsError("invalid-argument", "Brak communityId.");
  await requireCommunityRole(request, communityId, ["MASTER", "ADMIN"]);
  const snap = await db.collection(`communities/${communityId}/chatMessages`).get();
  let batch = db.batch();
  let ops = 0;
  for (const doc of snap.docs) {
    batch.set(doc.ref, {
      deleted: true,
      deletedAtMs: nowMs(),
      deletedByUid: request.auth?.uid || "",
      updatedAtMs: nowMs(),
    }, { merge: true });
    ops += 1;
    if (ops === 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return { ok: true, cleared: snap.size };
});

exports.upsertAiSource = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  await requireCommunityRole(request, communityId, ["MASTER", "ADMIN"]);
  const sourceId = safeText(request.data?.sourceId) || db.collection(`communities/${communityId}/aiSources`).doc().id;
  const ref = db.doc(`communities/${communityId}/aiSources/${sourceId}`);
  await ref.set({
    id: sourceId,
    communityId,
    name: safeText(request.data?.name || request.data?.sourceName),
    url: safeText(request.data?.url),
    category: safeText(request.data?.category),
    refreshEveryMinutes: Math.max(intValue(request.data?.refreshEveryMinutes || request.data?.refreshIntervalMinutes, 360), 15),
    filterRules: safeText(request.data?.filterRules || request.data?.filters),
    enabled: request.data?.enabled !== false,
    publishAsAnnouncement: request.data?.publishAsAnnouncement === true,
    updatedAtMs: nowMs(),
    updatedByUid: request.auth?.uid || "",
    createdAtMs: Number(request.data?.createdAtMs || nowMs()),
  }, { merge: true });
  return { ok: true, sourceId };
});

exports.deleteAiSource = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  const sourceId = safeText(request.data?.sourceId);
  if (!communityId || !sourceId) throw new HttpsError("invalid-argument", "Brak communityId lub sourceId.");
  await requireCommunityRole(request, communityId, ["MASTER", "ADMIN"]);
  await db.doc(`communities/${communityId}/aiSources/${sourceId}`).set({
    deleted: true,
    enabled: false,
    deletedAtMs: nowMs(),
    updatedAtMs: nowMs(),
    updatedByUid: request.auth?.uid || "",
  }, { merge: true });
  return { ok: true, sourceId };
});

exports.refreshCommunityAiSource = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  const sourceId = safeText(request.data?.sourceId);
  if (!communityId || !sourceId) throw new HttpsError("invalid-argument", "Brak communityId lub sourceId.");
  await requireCommunityRole(request, communityId, ["MASTER", "ADMIN"]);
  return { ok: true, ...(await refreshAiSourceInternal(communityId, sourceId, request.auth?.uid || "", { force: true })) };
});

exports.refreshCommunityAi = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  if (!communityId) throw new HttpsError("invalid-argument", "Brak communityId.");
  await requireCommunityRole(request, communityId, ["MASTER", "ADMIN"]);
  const sourcesSnap = await db.collection(`communities/${communityId}/aiSources`).where("enabled", "==", true).get();
  const results = [];
  for (const sourceDoc of sourcesSnap.docs) {
    results.push(await refreshAiSourceInternal(communityId, sourceDoc.id, request.auth?.uid || "", { force: true }).catch((error) => ({ sourceId: sourceDoc.id, error: safeText(error?.message) })));
  }
  return { ok: true, results };
});

exports.setAiNewsState = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  const newsId = safeText(request.data?.newsId);
  if (!communityId || !newsId) throw new HttpsError("invalid-argument", "Brak communityId lub newsId.");
  await requireCommunityRole(request, communityId, ["MASTER", "ADMIN"]);
  const ref = db.doc(`communities/${communityId}/aiNews/${newsId}`);
  const patch = {
    important: request.data?.important === true,
    pinned: request.data?.pinned === true,
    hidden: request.data?.hidden === true,
    archived: request.data?.archived === true,
    updatedAtMs: nowMs(),
    updatedByUid: request.auth?.uid || "",
  };
  await ref.set(patch, { merge: true });
  if (request.data?.publishAsAnnouncement === true) {
    const snap = await ref.get();
    if (snap.exists) {
      const item = { id: snap.id, ...snap.data() };
      const announcementId = await publishAiItemAsAnnouncement(communityId, item, request.auth?.uid || "");
      await ref.set({ publishedAsAnnouncement: true, announcementId, updatedAtMs: nowMs() }, { merge: true });
    }
  }
  return { ok: true, newsId };
});

exports.ksefSetConfig = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  if (!communityId) throw new HttpsError("invalid-argument", "Brak communityId.");
  await requireCommunityStaff(request, communityId);
  await assertPanelAccessEnabled(communityId);
  await db.doc(`communities/${communityId}/ksef/config`).set({
    environment: safeText(request.data?.environment || request.data?.mode || "MOCK").toUpperCase(),
    mode: safeText(request.data?.environment || request.data?.mode || "MOCK").toUpperCase(),
    nip: safeText(request.data?.nip),
    identifier: safeText(request.data?.identifier),
    token: safeText(request.data?.token),
    subjectType: safeText(request.data?.subjectType || "Subject2"),
    syncFrom: safeText(request.data?.syncFrom),
    syncTo: safeText(request.data?.syncTo),
    autoSyncEnabled: request.data?.autoSyncEnabled === true,
    autoSyncIntervalMinutes: Math.max(intValue(request.data?.autoSyncIntervalMinutes, 60), 15),
    autoSyncCount: Math.max(intValue(request.data?.autoSyncCount, 5), 1),
    retryEnabled: request.data?.retryEnabled !== false,
    retryMaxAttempts: Math.max(intValue(request.data?.retryMaxAttempts, 3), 1),
    retryDelayMinutes: Math.max(intValue(request.data?.retryDelayMinutes, 15), 5),
    dedupeEnabled: request.data?.dedupeEnabled !== false,
    updatedAtMs: nowMs(),
    updatedByUid: request.auth?.uid || "",
  }, { merge: true });
  return { ok: true };
});

exports.ksefRetryNow = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  if (!communityId) throw new HttpsError("invalid-argument", "Brak communityId.");
  await requireCommunityStaff(request, communityId);
  await assertPanelAccessEnabled(communityId);
  const period = parsePeriod(request.data?.period);
  const count = Math.max(intValue(request.data?.count, 2), 1);
  const created = [];
  for (let index = 0; index < count; index += 1) {
    const ref = db.collection("communities").doc(communityId).collection("invoices").doc();
    await ref.set({
      communityId,
      period,
      vendorName: index % 2 === 0 ? "TAURON" : "WODOCIAGI",
      title: index % 2 === 0 ? `Energia elektryczna ${period}` : `Woda i scieki ${period}`,
      totalGrossCents: index % 2 === 0 ? 184299 : 96340,
      currency: "PLN",
      source: "KSEF_RETRY",
      status: "NOWA",
      createdAtMs: nowMs(),
      updatedAtMs: nowMs(),
    }, { merge: true });
    created.push(ref.id);
  }
  await db.doc(`communities/${communityId}/ksef/config`).set({
    lastSyncSuccessAtMs: nowMs(),
    lastSyncError: "",
    lastSyncDuplicates: 0,
    updatedAtMs: nowMs(),
  }, { merge: true });
  return { ok: true, created, duplicates: [] };
});

exports.removeUser = onCall(async (request) => {
  const actorUid = requireAuth(request);
  const targetUid = safeText(request.data?.targetUid || request.data?.uid);
  if (!targetUid) throw new HttpsError("invalid-argument", "Brak targetUid.");

  const actor = await getMyProfile(actorUid);
  const targetRef = db.doc(`users/${targetUid}`);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) throw new HttpsError("not-found", "Użytkownik nie istnieje.");
  const target = targetSnap.data() || {};

  const actorRole = safeText(actor?.role);
  const targetRole = safeText(target?.role);
  const sameCommunity = profileCommunityId(actor) && profileCommunityId(actor) === profileCommunityId(target);
  const actorIsOwner = request.auth?.token?.owner === true || OWNER_UIDS.includes(actorUid) || OWNER_EMAILS.includes(safeText(request.auth?.token?.email));
  const actorCanManage = actorIsOwner || (sameCommunity && ["MASTER", "ADMIN", "ACCOUNTANT"].includes(actorRole));
  if (!actorCanManage) throw new HttpsError("permission-denied", "Brak uprawnień do usunięcia użytkownika.");
  if (targetRole === "MASTER" && !actorIsOwner && actorRole !== "MASTER") {
    throw new HttpsError("permission-denied", "Nie możesz usunąć konta MASTER.");
  }

  const now = nowMs();
  const batch = db.batch();
  batch.set(targetRef, {
    role: "REMOVED",
    removedAtMs: now,
    updatedAtMs: now,
    ...blockedPatch(true),
    communityId: null,
    customerId: null,
    activeCommunityId: null,
    currentCommunityId: null,
    selectedCommunityId: null,
    staircaseId: null,
    flatId: null,
    flatLabel: null,
  }, { merge: true });

  const communityId = safeText(target?.communityId);
  const flatId = safeText(target?.flatId);
  if (communityId && flatId) {
    const flatRef = db.doc(`communities/${communityId}/flats/${flatId}`);
    batch.set(flatRef, {
      residentUid: target?.residentUid === targetUid ? null : FieldValue.delete(),
      occupantsUids: FieldValue.arrayRemove(targetUid),
      updatedAtMs: now,
    }, { merge: true });
  }

  await batch.commit();
  return { ok: true };
});

exports.setUserBlocked = onCall(async (request) => {
  const actorUid = requireAuth(request);
  const targetUid = safeText(request.data?.targetUid || request.data?.uid);
  if (!targetUid) throw new HttpsError("invalid-argument", "Brak targetUid.");

  const actor = await getMyProfile(actorUid);
  const targetRef = db.doc(`users/${targetUid}`);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) throw new HttpsError("not-found", "Użytkownik nie istnieje.");
  const target = targetSnap.data() || {};

  const actorRole = safeText(actor?.role);
  const sameCommunity = profileCommunityId(actor) && profileCommunityId(actor) === profileCommunityId(target);
  const actorIsOwner = request.auth?.token?.owner === true || OWNER_UIDS.includes(actorUid) || OWNER_EMAILS.includes(safeText(request.auth?.token?.email));
  const actorCanManage = actorIsOwner || (sameCommunity && ["MASTER", "ADMIN", "ACCOUNTANT"].includes(actorRole));
  if (!actorCanManage) throw new HttpsError("permission-denied", "Brak uprawnień do blokady użytkownika.");

  await targetRef.set({ ...blockedPatch(!!request.data?.blocked), updatedAtMs: nowMs() }, { merge: true });
  return { ok: true };
});

exports.addStreet = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  const name = safeText(request.data?.name);
  if (!communityId || !name) throw new HttpsError("invalid-argument", "Brak communityId lub nazwy ulicy.");
  await requireCommunityStaff(request, communityId);
  const streetId = normalizeStreetName(name) || db.collection("communities").doc(communityId).collection("streets").doc().id;
  await db.doc(`communities/${communityId}/streets/${streetId}`).set({
    id: streetId,
    communityId,
    name,
    normalizedName: streetId,
    isActive: true,
    createdAtMs: nowMs(),
    updatedAtMs: nowMs(),
  }, { merge: true });
  return { id: streetId };
});

exports.createJoinCode = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  const role = safeText(request.data?.role || "ACCOUNTANT").toUpperCase();
  const { uid } = await requireCommunityRole(request, communityId, ["MASTER"]);
  if (["ACCOUNTANT", "ADMIN"].includes(role)) await assertPanelAccessEnabled(communityId);
  if (!["ACCOUNTANT", "ADMIN", "RESIDENT", "CONTRACTOR"].includes(role)) {
    throw new HttpsError("invalid-argument", "Nieobslugiwana rola join code.");
  }
  for (let i = 0; i < 10; i++) {
    const code = randomCode(8);
    const ref = db.doc(`join_codes/${code}`);
    try {
      await ref.create({ code, communityId, role, used: false, createdAtMs: nowMs(), createdByUid: uid, expiresAtMs: nowMs() + 30 * 24 * 3600 * 1000 });
      return { code };
    } catch (e) {
      if (e.code !== 6) throw e;
    }
  }
  throw new HttpsError("resource-exhausted", "Nie udało się wygenerować kodu.");
});

exports.claimJoinCode = onCall(async (request) => {
  const uid = requireAuth(request);
  const code = safeText(request.data?.code).toUpperCase();
  if (!code) throw new HttpsError("invalid-argument", "Brak kodu.");
  const joinRef = db.doc(`join_codes/${code}`);
  const joinSnap = await joinRef.get();
  if (!joinSnap.exists) throw new HttpsError("not-found", "Kod nie istnieje.");
  const joinData = joinSnap.data();
  if (["ACCOUNTANT", "ADMIN"].includes(safeText(joinData.role).toUpperCase())) {
    await assertPanelAccessEnabled(joinData.communityId);
  }
  return db.runTransaction(async (tx) => {
    const ref = db.doc(`join_codes/${code}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Kod nie istnieje.");
    const data = snap.data();
    if (data.used) throw new HttpsError("failed-precondition", "Kod został już wykorzystany.");
    if (Number(data.expiresAtMs || 0) < nowMs()) throw new HttpsError("deadline-exceeded", "Kod wygasł.");
    const finalRole = ["ACCOUNTANT", "ADMIN", "RESIDENT", "CONTRACTOR"].includes(safeText(data.role).toUpperCase()) ? safeText(data.role).toUpperCase() : "ACCOUNTANT";
    tx.set(db.doc(`users/${uid}`), {
      role: finalRole,
      communityId: data.communityId,
      customerId: data.communityId,
      activeCommunityId: data.communityId,
      currentCommunityId: data.communityId,
      selectedCommunityId: data.communityId,
      updatedAtMs: nowMs(),
    }, { merge: true });
    tx.update(ref, { used: true, usedByUid: uid, usedAtMs: nowMs() });
    return { ok: true, communityId: data.communityId, role: finalRole };
  });
});

exports.claimResidentFlat = onCall(async (request) => {
  const uid = requireAuth(request);
  const communityId = safeText(request.data?.communityId);
  if (!communityId) throw new HttpsError("invalid-argument", "Brak communityId.");
  const flat = await claimOrCreateFlatForResident({
    communityId,
    uid,
    flatId: safeText(request.data?.flatId),
    flatKey: safeText(request.data?.flatKey),
    street: safeText(request.data?.street),
    buildingNo: safeText(request.data?.buildingNo),
    apartmentNo: safeText(request.data?.apartmentNo),
    flatLabel: safeText(request.data?.flatLabel),
    staircaseId: safeText(request.data?.staircaseId),
  });
  await db.doc(`users/${uid}`).set({
    communityId,
    customerId: communityId,
    activeCommunityId: communityId,
    currentCommunityId: communityId,
    selectedCommunityId: communityId,
    street: flat.street,
    buildingNo: flat.buildingNo,
    apartmentNo: flat.apartmentNo,
    flatId: flat.flatId,
    staircaseId: flat.staircaseId || undefined,
    flatLabel: flat.flatLabel,
    updatedAtMs: nowMs(),
  }, { merge: true });
  return { ok: true, ...flat };
});

exports.createWebSession = onCall(async (request) => {
  const uid = requireAuth(request);
  const profile = await getMyProfile(uid);
  const communityId = profileCommunityId(profile);
  const role = safeText(profile?.role);
  if (!["MASTER", "ADMIN", "ACCOUNTANT"].includes(role)) throw new HttpsError("permission-denied", "Administrator nie ma dostepu do webpanelu.");
  await assertPanelAccessEnabled(communityId);
  const token = `${randomCode(12)}${randomCode(12)}`;
  const target = safeText(request.data?.target || "/dashboard");
  await db.doc(`webSessions/${token}`).set({ uid, communityId, used: false, target, createdAtMs: nowMs(), expiresAtMs: nowMs() + 15 * 60 * 1000 });
  return { token, target };
});

exports.ksefFetchInvoices = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  await requireCommunityStaff(request, communityId);
  await assertPanelAccessEnabled(communityId);
  const period = parsePeriod(request.data?.period);
  const list = [
    { vendorName: "TAURON", title: `Energia elektryczna ${period}`, totalGrossCents: 184299, currency: "PLN" },
    { vendorName: "WODOCIĄGI", title: `Woda i ścieki ${period}`, totalGrossCents: 96340, currency: "PLN" },
  ];
  const batch = db.batch();
  const createdIds = [];
  list.forEach((item) => {
    const ref = db.collection("communities").doc(communityId).collection("invoices").doc();
    createdIds.push(ref.id);
    batch.set(ref, {
      ...item,
      communityId,
      period,
      status: "NOWA",
      source: "KSEF_MOCK",
      createdAtMs: nowMs(),
      updatedAtMs: nowMs(),
    }, { merge: true });
  });
  await batch.commit();
  await db.doc(`communities/${communityId}/ksef/config`).set({
    lastSyncSuccessAtMs: nowMs(),
    lastSyncError: "",
    lastSyncDuplicates: 0,
    updatedAtMs: nowMs(),
  }, { merge: true });
  return { ok: true, created: createdIds, duplicates: [] };
});

exports.ksefParseInvoice = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  const invoiceId = safeText(request.data?.invoiceId);
  await requireCommunityStaff(request, communityId);
  await assertPanelAccessEnabled(communityId);
  const ref = db.collection("communities").doc(communityId).collection("invoices").doc(invoiceId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Faktura nie istnieje.");
  const invoice = { id: snap.id, ...snap.data() };
  const period = parsePeriod(invoice.period || request.data?.period);
  const rule = await findRuleMatch(communityId, invoice);
  const parsed = {
    category: normalizeCategory(rule?.category || invoice.category || (safeText(invoice.vendorName).toUpperCase().includes("TAURON") ? "PRAD" : safeText(invoice.vendorName).toUpperCase().includes("WOD") ? "WODA" : "INNE")),
    amountCents: Number(invoice.totalGrossCents || invoice.amountCents || 0),
    period,
    scope: safeText(rule?.scope || invoice.scope || "COMMON"),
    common: safeText(rule?.scope || invoice.scope || "COMMON") !== "FLAT",
    buildingId: safeText(rule?.buildingId || invoice.buildingId || ""),
    flatId: safeText(rule?.flatId || invoice.flatId || ""),
    confidence: rule ? 0.99 : 0.72,
    matchedBy: rule ? "RULE" : "HEURISTIC",
  };
  await ref.set({ parsed, status: rule ? "READY_TO_APPROVE" : "SUGGESTED", updatedAtMs: nowMs() }, { merge: true });
  return { ok: true, parsed };
});

exports.aiSuggestInvoice = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  const invoiceId = safeText(request.data?.invoiceId);
  await requireCommunityStaff(request, communityId);
  await assertPanelAccessEnabled(communityId);
  const ref = db.collection("communities").doc(communityId).collection("invoices").doc(invoiceId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Faktura nie istnieje.");
  const inv = snap.data();
  const parsed = inv.parsed || {};
  const suggestion = {
    category: normalizeCategory(parsed.category || inv.category || "INNE"),
    buildingId: safeText(parsed.buildingId || inv.buildingId || ""),
    period: parsePeriod(parsed.period || inv.period),
    common: parsed.scope !== "FLAT",
    confidence: Math.max(Number(parsed.confidence || 0.67), 0.67),
    source: "AI_SUGGESTION",
  };
  const suggRef = db.collection("communities").doc(communityId).collection("aiSuggestions").doc();
  await suggRef.set({ invoiceId, suggestion, createdAtMs: nowMs() });
  await ref.set({ ai: { suggestion, updatedAtMs: nowMs() }, status: suggestion.confidence >= 0.85 ? "READY_TO_APPROVE" : "SUGGESTED", updatedAtMs: nowMs() }, { merge: true });
  if (suggestion.confidence < 0.85) {
    const reviewCol = db.collection("communities").doc(communityId).collection("reviewQueue");
    const existingOpen = await reviewCol.where("invoiceId", "==", invoiceId).where("type", "==", "INVOICE_LOW_CONFIDENCE").where("status", "==", "OPEN").limit(1).get();
    if (existingOpen.empty) {
      await reviewCol.add({ type: "INVOICE_LOW_CONFIDENCE", invoiceId, confidence: suggestion.confidence, status: "OPEN", createdAtMs: nowMs() });
    }
  }
  return { ok: true, suggestion };
});

exports.approveInvoice = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  const invoiceId = safeText(request.data?.invoiceId);
  const assignment = request.data?.assignment || {};
  await requireCommunityStaff(request, communityId);
  await assertPanelAccessEnabled(communityId);
  const invRef = db.collection("communities").doc(communityId).collection("invoices").doc(invoiceId);
  const invSnap = await invRef.get();
  if (!invSnap.exists) throw new HttpsError("not-found", "Faktura nie istnieje.");
  const inv = invSnap.data();
  const parsed = inv.parsed || {};
  const period = parsePeriod(assignment.period || parsed.period || inv.period);
  const category = normalizeCategory(assignment.category || parsed.category || inv.category || "INNE");
  const scope = safeText(assignment.scope || parsed.scope || "COMMON");
  const amountCents = Number(parsed.amountCents || inv.totalGrossCents || inv.amountCents || 0);
  const buildingId = safeText(assignment.buildingId || parsed.buildingId || inv.buildingId || "");
  const dueDateMs = Number(assignment.dueDateMs || inv.dueDateMs || periodToDueDateMs(period));
  const dueDate = new Date(dueDateMs).toISOString().slice(0, 10);
  const transferAccount = safeText(inv.accountNumber || request.data?.accountNumber || "00 0000 0000 0000 0000 0000 0000");
  const flatsQ = db.collection("communities").doc(communityId).collection("flats");
  let flatsSnap;
  if (scope === "FLAT") {
    const flatId = safeText(assignment.flatId || parsed.flatId || inv.flatId);
    if (!flatId) throw new HttpsError("invalid-argument", "Brak flatId dla faktury typu FLAT.");
    const flatSnap = await flatsQ.doc(flatId).get();
    if (!flatSnap.exists) throw new HttpsError("not-found", "Lokal nie istnieje.");
    flatsSnap = { docs: [flatSnap] };
  } else if (buildingId) {
    flatsSnap = await flatsQ.where("buildingId", "==", buildingId).get();
  } else {
    flatsSnap = await flatsQ.get();
  }
  const flats = flatsSnap.docs.filter((d) => d.exists).map((d) => ({ id: d.id, ...d.data() }));
  if (!flats.length) throw new HttpsError("failed-precondition", "Brak lokali do naliczenia.");
  const totalArea = flats.reduce((a, f) => a + Number(f.areaM2 || 0), 0);
  const useArea = totalArea > 0;
  let allocated = 0;
  let chargesCreated = 0;
  for (let i = 0; i < flats.length; i++) {
    const flat = flats[i];
    let part;
    if (i === flats.length - 1) {
      part = amountCents - allocated;
    } else if (useArea) {
      part = Math.round(amountCents * (Number(flat.areaM2 || 0) / totalArea));
    } else {
      part = Math.floor(amountCents / flats.length);
    }
    allocated += part;
    const chargeRef = db.collection("communities").doc(communityId).collection("charges").doc();
    await chargeRef.set({
      invoiceId,
      flatId: flat.id,
      buildingId: flat.buildingId || buildingId || null,
      period,
      category,
      label: safeText(assignment.label || parsed.label || inv.title || `${category} ${period}`),
      amountCents: part,
      currency: safeText(inv.currency || "PLN"),
      source: "INVOICE_APPROVAL",
      createdAtMs: nowMs(),
      updatedAtMs: nowMs(),
    });
    chargesCreated += 1;
    const settlementRef = db.collection("communities").doc(communityId).collection("settlements").doc(`${flat.id}_${period}`);
    const existing = await settlementRef.get();
    const current = existing.exists ? existing.data() : { paymentsCents: 0 };
    const chargesCents = Number(current?.chargesCents || 0) + part;
    const paymentsCents = Number(current?.paymentsCents || 0);
    const balanceCents = chargesCents - paymentsCents;
    await settlementRef.set({
      flatId: flat.id,
      buildingId: flat.buildingId || buildingId || null,
      period,
      title: `Rozliczenie za ${monthTitle(period)}`,
      chargesCents,
      paymentsCents,
      balanceCents,
      currency: safeText(inv.currency || "PLN"),
      dueDateMs,
      dueDate,
      accountNumber: transferAccount,
      transferTitle: `EL-${safeText(flat.flatNumber || flat.localNumber || flat.id)} ${period}`,
      flatLabel: safeText(flat.flatLabel || [flat.street, flat.buildingNo, flat.apartmentNo].filter(Boolean).join(' ')),
      residentName: safeText(flat.name || flat.displayName || ''),
      isPublished: false,
      status: 'DRAFT',
      createdAtMs: Number(current?.createdAtMs || nowMs()),
      updatedAtMs: nowMs(),
    }, { merge: true });
    await refreshBalanceDoc(communityId, flat.id);
  }
  await invRef.set({ status: "STAGED", approvedAtMs: nowMs(), approvedAssignment: { period, category, scope, buildingId, dueDateMs } }, { merge: true });
  const openReviewSnap = await db.collection("communities").doc(communityId).collection("reviewQueue").where("invoiceId", "==", invoiceId).where("status", "==", "OPEN").get();
  for (const docSnap of openReviewSnap.docs) {
    await docSnap.ref.set({ status: "CLOSED", resolution: "closed-after-approval", closedAtMs: nowMs() }, { merge: true });
  }
  return { ok: true, chargesCreated, period, dueDateMs };
});

exports.importPayments = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  const rows = Array.isArray(request.data?.rows) ? request.data.rows : [];
  await requireCommunityStaff(request, communityId);
  await assertPanelAccessEnabled(communityId);
  let matched = 0;
  let unmatched = 0;
  const created = [];
  for (const row of rows) {
    const title = safeText(row.title || row.description || row.tytul || row.tytuł || row.opis);
    const amountCents = parseAmountToCents(row.amount ?? row.kwota);
    const bookedAtMs = Number(row.bookedAtMs || row.dateMs || Date.parse(row.date || row.data || new Date().toISOString()) || nowMs());
    const code = paymentCodeFromText(`${title} ${safeText(row.code)}`);
    let flatSnap = null;
    let matchedBy = "NONE";
    if (code) {
      const q = await db.collection("communities").doc(communityId).collection("flats").where("flatNumber", "==", code).limit(1).get();
      flatSnap = q.docs[0] || null;
      if (flatSnap) matchedBy = "CODE";
    }
    if (!flatSnap) {
      flatSnap = await fuzzyFindFlatForPayment(communityId, row);
      if (flatSnap) matchedBy = "AI_HINT";
    }
    const paymentRef = db.collection("communities").doc(communityId).collection("payments").doc();
    const period = parsePeriod(row.period || new Date(bookedAtMs).toISOString().slice(0, 7));
    const payload = {
      flatId: flatSnap?.id || null,
      period,
      code: code || null,
      title,
      source: safeText(row.source || "CSV_IMPORT"),
      amountCents,
      bookedAtMs,
      createdAtMs: nowMs(),
      updatedAtMs: nowMs(),
      matched: !!flatSnap,
      matchedBy,
    };
    await paymentRef.set(payload);
    created.push(paymentRef.id);
    if (flatSnap) {
      matched += 1;
      const settlementRef = db.collection("communities").doc(communityId).collection("settlements").doc(`${flatSnap.id}_${period}`);
      const settlementSnap = await settlementRef.get();
      const settlement = settlementSnap.exists ? settlementSnap.data() : { chargesCents: 0, accountNumber: "", transferTitle: `EL-${code} ${period}`, dueDateMs: periodToDueDateMs(period), dueDate: new Date(periodToDueDateMs(period)).toISOString().slice(0,10) };
      const paymentsCents = Number(settlement?.paymentsCents || 0) + amountCents;
      const chargesCents = Number(settlement?.chargesCents || 0);
      await settlementRef.set({
        flatId: flatSnap.id,
        buildingId: flatSnap.get("buildingId") || null,
        period,
        title: `Rozliczenie za ${monthTitle(period)}`,
        chargesCents,
        paymentsCents,
        balanceCents: chargesCents - paymentsCents,
        accountNumber: settlement.accountNumber || "",
        transferTitle: settlement.transferTitle || `EL-${code} ${period}`,
        isPublished: Boolean(settlement.isPublished),
        status: settlement.status || 'DRAFT',
        dueDateMs: settlement.dueDateMs || periodToDueDateMs(period),
        dueDate: settlement.dueDate || new Date(periodToDueDateMs(period)).toISOString().slice(0,10),
        createdAtMs: Number(settlement.createdAtMs || nowMs()),
        updatedAtMs: nowMs(),
      }, { merge: true });
      await refreshBalanceDoc(communityId, flatSnap.id);
    } else {
      unmatched += 1;
      await db.collection("communities").doc(communityId).collection("reviewQueue").add({ type: "PAYMENT_UNMATCHED", paymentId: paymentRef.id, title, amountCents, code: code || null, source: safeText(row.source || ""), status: "OPEN", createdAtMs: nowMs() });
    }
  }
  return { ok: true, matched, unmatched, created };
});


exports.publishSettlement = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  const settlementId = safeText(request.data?.settlementId);
  await requireCommunityStaff(request, communityId);
  await assertPanelAccessEnabled(communityId);
  const ref = db.collection("communities").doc(communityId).collection("settlements").doc(settlementId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Rozliczenie nie istnieje.");
  await ref.set({ isPublished: true, status: "PUBLISHED", publishedAtMs: nowMs(), updatedAtMs: nowMs() }, { merge: true });
  return { ok: true, settlementId };
});

exports.publishAllDraftSettlements = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  await requireCommunityStaff(request, communityId);
  await assertPanelAccessEnabled(communityId);
  const snap = await db.collection("communities").doc(communityId).collection("settlements").where("isPublished", "!=", true).get();
  const batch = db.batch();
  snap.docs.forEach((docSnap) => batch.set(docSnap.ref, { isPublished: true, status: "PUBLISHED", publishedAtMs: nowMs(), updatedAtMs: nowMs() }, { merge: true }));
  await batch.commit();
  return { ok: true, published: snap.size };
});

exports.generateSettlementPdf = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  const settlementId = safeText(request.data?.settlementId);
  await requireCommunityStaff(request, communityId);
  await assertPanelAccessEnabled(communityId);
  const settlementRef = db.collection("communities").doc(communityId).collection("settlements").doc(settlementId);
  const snap = await settlementRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Rozliczenie nie istnieje.");
  const settlement = snap.data();
  const detail = await getSettlementData(communityId, settlement.flatId, settlement.period);
  const uploaded = await uploadSettlementPdf(communityId, settlementId, {
    ...settlement,
    ...detail,
  });
  await settlementRef.set({ pdfPath: uploaded.path, pdfUrl: uploaded.url, updatedAtMs: nowMs() }, { merge: true });
  return { ok: true, pdfUrl: uploaded.url, pdfPath: uploaded.path };
});

exports.sendSettlementEmail = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  const settlementId = safeText(request.data?.settlementId);
  await requireCommunityStaff(request, communityId);
  await assertPanelAccessEnabled(communityId);
  const settlementRef = db.collection("communities").doc(communityId).collection("settlements").doc(settlementId);
  const settlementSnap = await settlementRef.get();
  if (!settlementSnap.exists) throw new HttpsError("not-found", "Rozliczenie nie istnieje.");
  const settlement = settlementSnap.data();
  const flatId = safeText(settlement.flatId);
  const payerSnap = await db.collection("communities").doc(communityId).collection("payers").where("flatId", "==", flatId).limit(1).get();
  const flatSnap = await db.collection("communities").doc(communityId).collection("flats").doc(flatId).get();
  const payer = payerSnap.docs[0]?.data() || {};
  const flat = flatSnap.exists ? flatSnap.data() : {};
  const email = sanitizeEmail(request.data?.email || payer.email || flat.email);
  if (!email) {
    await db.collection("communities").doc(communityId).collection("reviewQueue").add({ type: "MISSING_EMAIL", settlementId, flatId, status: "OPEN", createdAtMs: nowMs() });
    throw new HttpsError("failed-precondition", "Brak adresu email dla płatnika.");
  }
  let pdfUrl = settlement.pdfUrl || null;
  if (!pdfUrl) {
    const detail = await getSettlementData(communityId, settlement.flatId, settlement.period);
    const uploaded = await uploadSettlementPdf(communityId, settlementId, { ...settlement, ...detail });
    pdfUrl = uploaded.url;
    await settlementRef.set({ pdfPath: uploaded.path, pdfUrl, updatedAtMs: nowMs() }, { merge: true });
  }
  const queueRef = db.collection("communities").doc(communityId).collection("emailQueue").doc();
  await queueRef.set({
    to: email,
    subject: `Rozliczenie za ${monthTitle(settlement.period)}`,
    template: "settlement",
    settlementId,
    flatId,
    pdfUrl,
    status: "QUEUED",
    createdAtMs: nowMs(),
    payload: {
      period: settlement.period,
      balanceCents: settlement.balanceCents,
      transferTitle: settlement.transferTitle,
      accountNumber: settlement.accountNumber,
    },
  });
  await settlementRef.set({ emailedAtMs: nowMs(), emailedTo: email, updatedAtMs: nowMs() }, { merge: true });
  return { ok: true, queued: true, email, pdfUrl };
});

exports.closeReviewItem = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  const reviewId = safeText(request.data?.reviewId);
  await requireCommunityStaff(request, communityId);
  await assertPanelAccessEnabled(communityId);
  await db.collection("communities").doc(communityId).collection("reviewQueue").doc(reviewId).set({ status: safeText(request.data?.status || "CLOSED"), resolution: safeText(request.data?.resolution || ""), closedAtMs: nowMs() }, { merge: true });
  return { ok: true };
});

