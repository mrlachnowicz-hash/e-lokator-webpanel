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
  const ok = ["MASTER", "ADMIN", "ACCOUNTANT"].includes(role) && String(profile?.communityId || "") === String(communityId || "");
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
  if (!community || community.panelAccessEnabled !== true) {
    throw new HttpsError("permission-denied", "Panel nie jest aktywny dla tej wspólnoty.");
  }
  return community;
}


async function requireCommunityRole(request, communityId, allowedRoles) {
  const uid = requireAuth(request);
  const profile = await getMyProfile(uid);
  const role = String(profile?.role || "");
  const ok = Array.isArray(allowedRoles) && allowedRoles.includes(role) && String(profile?.communityId || "") === String(communityId || "");
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
      const seatsTotal = Number(communitySnap.get("seatsTotal") || 0);
      const seatsUsed = Number(communitySnap.get("seatsUsed") || 0);
      if (seatsUsed >= seatsTotal) {
        throw new HttpsError("failed-precondition", "Brak wolnych seats. Dokup i zatwierdź seats w generatorze ownera.");
      }
      tx.set(communityRef, { seatsUsed: seatsUsed + 1, updatedAtMs: now }, { merge: true });
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
      seatsUsed: exists ? Number(communitySnap.get("seatsUsed") || 0) : Number(communitySnap.get("seatsUsed") || 0) + 1,
      seatsTotal: Number(communitySnap.get("seatsTotal") || 0),
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
  const snap = await db.collection("users")
    .where("communityId", "==", communityId)
    .where("role", "in", ["ADMIN", "MASTER"])
    .get();
  return snap.docs.map((d) => d.data().fcmToken).filter(Boolean);
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
  if (!name || nip.length !== 10) throw new HttpsError("invalid-argument", "Podaj nazwę i poprawny NIP.");
  for (let i = 0; i < 10; i++) {
    const code = randomCode(10);
    const ref = db.doc(`activation_codes/${code}`);
    try {
      await ref.create({ code, name, nip, used: false, status: "ACTIVE", createdAtMs: nowMs(), createdByUid: request.auth.uid });
      return { code, docPath: ref.path };
    } catch (e) {
      if (e.code !== 6) throw e;
    }
  }
  throw new HttpsError("resource-exhausted", "Błąd generowania kodu.");
});

exports.createInvite = onCall(async (request) => {
  const uid = requireAuth(request);
  const me = await getMyProfile(uid);
  const communityId = safeText(request.data?.communityId || me?.communityId);
  const role = safeText(request.data?.role || "RESIDENT");
  const invite = {
    customerId: me?.customerId || me?.communityId || communityId,
    communityId,
    role,
    status: "active",
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
  const code = safeText(request.data?.code);
  const nip = safeText(request.data?.nip);
  const name = safeText(request.data?.name);
  if (!code || !nip || !name) throw new HttpsError("invalid-argument", "Brak danych aktywacji.");
  const communityDoc = db.collection("communities").doc();
  return db.runTransaction(async (tx) => {
    tx.set(communityDoc, { id: communityDoc.id, name, nip, createdAtMs: nowMs(), seatsTotal: 2, seatsUsed: 0, panelAccessEnabled: false, updatedAtMs: nowMs() });
    tx.set(db.doc(`users/${uid}`), { role: "MASTER", communityId: communityDoc.id, customerId: communityDoc.id, updatedAtMs: nowMs() }, { merge: true });
    tx.set(db.doc(`activation_codes/${code}`), { used: true, communityId: communityDoc.id, usedAtMs: nowMs() }, { merge: true });
    return { communityId: communityDoc.id };
  });
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
  const sameCommunity = safeText(actor?.communityId) && safeText(actor?.communityId) === safeText(target?.communityId);
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
    appBlocked: true,
    communityId: null,
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
  const sameCommunity = safeText(actor?.communityId) && safeText(actor?.communityId) === safeText(target?.communityId);
  const actorIsOwner = request.auth?.token?.owner === true || OWNER_UIDS.includes(actorUid) || OWNER_EMAILS.includes(safeText(request.auth?.token?.email));
  const actorCanManage = actorIsOwner || (sameCommunity && ["MASTER", "ADMIN", "ACCOUNTANT"].includes(actorRole));
  if (!actorCanManage) throw new HttpsError("permission-denied", "Brak uprawnień do blokady użytkownika.");

  await targetRef.set({ appBlocked: !!request.data?.blocked, updatedAtMs: nowMs() }, { merge: true });
  return { ok: true };
});

exports.addStreet = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  const name = safeText(request.data?.name);
  if (!communityId || !name) throw new HttpsError("invalid-argument", "Brak communityId lub nazwy ulicy.");
  await requireCommunityStaff(request, communityId);
  const ref = db.collection("communities").doc(communityId).collection("streets").doc();
  await ref.set({ name, createdAtMs: nowMs(), updatedAtMs: nowMs() });
  return { id: ref.id };
});

exports.createJoinCode = onCall(async (request) => {
  const communityId = safeText(request.data?.communityId);
  const role = "ACCOUNTANT";
  const { uid } = await requireCommunityRole(request, communityId, ["MASTER"]);
  await assertPanelAccessEnabled(communityId);
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
  await assertPanelAccessEnabled(joinData.communityId);
  return db.runTransaction(async (tx) => {
    const ref = db.doc(`join_codes/${code}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Kod nie istnieje.");
    const data = snap.data();
    if (data.used) throw new HttpsError("failed-precondition", "Kod został już wykorzystany.");
    if (Number(data.expiresAtMs || 0) < nowMs()) throw new HttpsError("deadline-exceeded", "Kod wygasł.");
    const finalRole = safeText(data.role || "ACCOUNTANT") === "ACCOUNTANT" ? "ACCOUNTANT" : "ACCOUNTANT";
    tx.set(db.doc(`users/${uid}`), { role: finalRole, communityId: data.communityId, customerId: data.communityId, updatedAtMs: nowMs() }, { merge: true });
    tx.update(ref, { used: true, usedByUid: uid, usedAtMs: nowMs() });
    return { ok: true, communityId: data.communityId, role: "ACCOUNTANT" };
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
  const communityId = safeText(profile?.communityId);
  const role = safeText(profile?.role);
  if (!["MASTER", "ACCOUNTANT"].includes(role)) throw new HttpsError("permission-denied", "Administrator nie ma dostępu do webpanelu.");
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
  return { ok: true, createdIds };
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
