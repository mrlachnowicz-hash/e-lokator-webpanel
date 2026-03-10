const admin = require("firebase-admin");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { XMLParser } = require("fast-xml-parser");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

let OpenAI = null;
let pdfParse = null;
try { OpenAI = require("openai").default; } catch (e) {}
try { pdfParse = require("pdf-parse"); } catch (e) {}

setGlobalOptions({ region: "europe-west1" });

try {
  admin.app();
} catch (e) {
  admin.initializeApp();
}

const db = admin.firestore();
const RUNTIME_FIX_VERSION = "2026-03-10-r8";
const SETTLEMENTS_COLLECTION = "settlements";
const SETTLEMENT_DRAFTS_COLLECTION = "settlementDrafts";

// =========================================================
// BASIC HELPERS
// =========================================================

function nowMs() {
  return Date.now();
}

function safeString(v) {
  return String(v || "").trim();
}

function normalizeStreetName(name) {
  return safeString(name)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function randomCode(len = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return out;
}

function randomToken(len = 48) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return out;
}

function toCents(value) {
  if (value == null) return 0;
  const n = Number(String(value).replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function fromCents(cents) {
  return Number(cents || 0) / 100;
}

function monthFromDateStr(yyyyMmDd) {
  const s = safeString(yyyyMmDd);
  return s.length >= 7 ? s.slice(0, 7) : "";
}

function formatMoney(cents) {
  const val = Number(cents || 0);
  const sign = val < 0 ? "-" : "";
  const abs = Math.abs(val);
  const z = Math.floor(abs / 100);
  const g = String(abs % 100).padStart(2, "0");
  return `${sign}${z},${g} PLN`;
}

function valueOr(a, b) {
  return safeString(a) || safeString(b);
}

function paymentCodeForFlat(flat) {
  return safeString(flat.paymentCode || flat.flatLabel || `${flat.street || ""}-${flat.buildingNo || ""}-${flat.apartmentNo || ""}`)
    .replace(/\s+/g, "-")
    .replace(/[^\w\-\/]/g, "")
    .toUpperCase()
    .slice(0, 18);
}

function shortHash(input) {
  return crypto.createHash("sha256").update(safeString(input || "X"), "utf8").digest("hex").toUpperCase().slice(0, 6);
}

function simpleHash(input) {
  let hash = 2166136261;
  const text = safeString(input || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tripletFromSeed(seed, salt) {
  return String(simpleHash(`${salt}|${seed}`) % 1000).padStart(3, "0");
}

function normalizePlain(value) {
  return safeString(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

const PAYMENT_REF_REGEX = /\b([A-Z]{2}-\d{3}-\d{3}-\d{3}-20\d{2}-\d{2})\b/i;

function normalizePaymentRef(value) {
  const input = safeString(value).toUpperCase().replace(/[–—]/g, "-");
  const direct = input.match(PAYMENT_REF_REGEX);
  if (direct?.[1]) return direct[1];
  const relaxed = input.replace(/[^A-Z0-9]/g, " ").replace(/\s+/g, " ").trim().match(/\b([A-Z]{2})\s*(\d{3})\s*(\d{3})\s*(\d{3})\s*(20\d{2})\s*(\d{2})\b/);
  return relaxed ? `${relaxed[1]}-${relaxed[2]}-${relaxed[3]}-${relaxed[4]}-${relaxed[5]}-${relaxed[6]}` : "";
}

function extractPaymentRef(value) {
  return normalizePaymentRef(value);
}

function buildStablePaymentRef(flat = {}, period = "") {
  const periodMatch = safeString(period || nowMs()).match(/^(20\d{2})-(\d{2})/);
  const year = periodMatch?.[1] || new Date().toISOString().slice(0, 4);
  const month = periodMatch?.[2] || new Date().toISOString().slice(5, 7);
  const seed = [
    flat.communityId || "",
    flat.id || flat.flatId || "",
    flat.street || flat.streetName || "",
    flat.buildingNo || flat.buildingId || "",
    flat.apartmentNo || flat.flatNumber || "",
    flat.flatLabel || "",
    `${year}-${month}`,
  ].join("|");
  const aptDigits = normalizePlain(flat.apartmentNo || flat.flatNumber || flat.flatId || flat.id || flat.flatLabel || "").replace(/[^0-9]/g, "");
  const part1 = aptDigits ? aptDigits.slice(-3).padStart(3, "0") : tripletFromSeed(seed, "APT");
  const part2 = tripletFromSeed(seed, "B");
  const part3 = tripletFromSeed(seed, "C");
  return `EL-${part1}-${part2}-${part3}-${year}-${month}`;
}

function ensurePaymentRef(existingValue, flat = {}, period = "") {
  return normalizePaymentRef(existingValue) || buildStablePaymentRef(flat, period);
}

function normalizeLookup(value) {
  return safeString(value)
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

function normalizeBuildingNo(value) {
  return normalizeLookup(value).replace(/\s+/g, "");
}

function parseAddressHints(text) {
  const raw = safeString(text);
  const normalized = normalizeLookup(raw);
  const out = { streetName: "", buildingNo: "", apartmentNo: "", staircaseId: "" };
  const streetMatch = raw.match(/(?:ul(?:ica)?|al(?:eja)?|os(?:iedle)?)\.?\s+([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż .-]{3,})/i);
  if (streetMatch?.[1]) out.streetName = safeString(streetMatch[1]).split(/\s+(?:nr|bud|budynku|lok|lokalu|kl|klatka)\b/i)[0];
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

function readCommunityPaymentDefaults(community) {
  return {
    accountNumber: safeString(community?.defaultAccountNumber || community?.accountNumber || community?.bankAccount || community?.paymentSettings?.accountNumber || community?.paymentDefaults?.accountNumber),
    recipientName: safeString(community?.recipientName || community?.receiverName || community?.transferName || community?.paymentSettings?.recipientName || community?.paymentDefaults?.recipientName || community?.name),
    recipientAddress: safeString(community?.recipientAddress || community?.receiverAddress || community?.transferAddress || community?.paymentSettings?.recipientAddress || community?.paymentDefaults?.recipientAddress),
  };
}

async function buildPaymentTitle(flat, period, existingValue = "") {
  return ensurePaymentRef(existingValue, flat, period);
}

function getOpenAIClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !OpenAI) return null;
  return new OpenAI({ apiKey: key });
}


function settlementDocId(flatId, period) {
  return `${flatId}_${period}`.replace(/[^\w\-]/g, "_");
}

async function getSettlementRefs(communityId, settlementId) {
  return {
    publishedRef: db.doc(`communities/${communityId}/${SETTLEMENTS_COLLECTION}/${settlementId}`),
    draftRef: db.doc(`communities/${communityId}/${SETTLEMENT_DRAFTS_COLLECTION}/${settlementId}`),
  };
}

async function getSettlementState(communityId, settlementId) {
  const { publishedRef, draftRef } = await getSettlementRefs(communityId, settlementId);
  const [publishedSnap, draftSnap] = await Promise.all([publishedRef.get(), draftRef.get()]);
  return {
    publishedRef,
    draftRef,
    publishedSnap,
    draftSnap,
    published: publishedSnap.exists ? publishedSnap.data() : null,
    draft: draftSnap.exists ? draftSnap.data() : null,
  };
}

async function getPreferredSettlement(communityId, settlementId) {
  const state = await getSettlementState(communityId, settlementId);
  if (state.published) return { ref: state.publishedRef, data: state.published, collection: SETTLEMENTS_COLLECTION };
  if (state.draft) return { ref: state.draftRef, data: state.draft, collection: SETTLEMENT_DRAFTS_COLLECTION };
  return { ref: state.publishedRef, data: null, collection: SETTLEMENTS_COLLECTION };
}

async function listSettlementCandidates(communityId, publishedOnly = false) {
  const [publishedSnap, draftSnap] = await Promise.all([
    db.collection(`communities/${communityId}/${SETTLEMENTS_COLLECTION}`).get(),
    publishedOnly ? Promise.resolve({ docs: [] }) : db.collection(`communities/${communityId}/${SETTLEMENT_DRAFTS_COLLECTION}`).get(),
  ]);
  const map = new Map();
  if (!publishedOnly) {
    draftSnap.docs.forEach((doc) => map.set(doc.id, { id: doc.id, ...doc.data(), __collection: SETTLEMENT_DRAFTS_COLLECTION }));
  }
  publishedSnap.docs.forEach((doc) => map.set(doc.id, { id: doc.id, ...doc.data(), __collection: SETTLEMENTS_COLLECTION, isPublished: true }));
  return Array.from(map.values());
}

// =========================================================
// AUTH / ROLE HELPERS
// =========================================================

async function getMe(uid) {
  if (!uid) return null;
  const snap = await db.doc(`users/${uid}`).get();
  return snap.exists ? snap.data() : null;
}

async function assertSignedIn(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Zaloguj się.");
  }
  const me = await getMe(request.auth.uid);
  if (!me) throw new HttpsError("failed-precondition", "Brak profilu użytkownika.");
  if (me.appBlocked === true) throw new HttpsError("permission-denied", "Konto zablokowane.");
  return me;
}

function hasRole(me, roles) {
  return me && roles.includes(String(me.role || "RESIDENT"));
}

async function assertStaff(request) {
  const me = await assertSignedIn(request);
  if (!hasRole(me, ["MASTER", "ADMIN", "ACCOUNTANT"])) {
    throw new HttpsError("permission-denied", "Brak uprawnień.");
  }
  return me;
}

async function assertAdminOrMaster(request) {
  const me = await assertSignedIn(request);
  if (!hasRole(me, ["MASTER", "ADMIN"])) {
    throw new HttpsError("permission-denied", "Brak uprawnień.");
  }
  return me;
}

async function assertMaster(request) {
  const me = await assertSignedIn(request);
  if (!hasRole(me, ["MASTER"])) {
    throw new HttpsError("permission-denied", "Brak uprawnień.");
  }
  return me;
}

async function assertSameCommunity(me, communityId) {
  if (!communityId || communityId !== me.communityId) {
    throw new HttpsError("permission-denied", "Inna wspólnota.");
  }
}

const OWNER_UIDS = ["C4NPiqCNCChdDZ0s54di5g8Mt5l2"];
const OWNER_EMAILS = ["mrlachnowicz@gmail.com"];

function assertOwner(request) {
  if (!request.auth || !request.auth.uid) throw new HttpsError("unauthenticated", "Zaloguj się.");
  const token = request.auth.token || {};
  const email = String(request.auth.token.email || "");
  const ok = token.owner === true || OWNER_UIDS.includes(request.auth.uid) || OWNER_EMAILS.includes(email);
  if (!ok) throw new HttpsError("permission-denied", "Brak uprawnień Ownera.");
}

// =========================================================
// COMMUNITY / FLATS / USERS HELPERS
// =========================================================

async function getCommunity(communityId) {
  const snap = await db.doc(`communities/${communityId}`).get();
  return snap.exists ? snap.data() : null;
}

async function getFlat(communityId, flatId) {
  const snap = await db.doc(`communities/${communityId}/flats/${flatId}`).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function listFlats(communityId, buildingId = null, streetId = null) {
  const snap = await db.collection(`communities/${communityId}/flats`).get();
  let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (streetId) {
    rows = rows.filter((x) => safeString(x.streetId) === safeString(streetId));
  }
  if (buildingId) {
    rows = rows.filter((x) => {
      const a = safeString(x.buildingId);
      const b = safeString(x.buildingNo);
      const c = safeString(buildingId);
      return a === c || b === c;
    });
  }
  return rows;
}

async function getFlatResidents(communityId, flatId) {
  const snap = await db.collection("users")
    .where("communityId", "==", communityId)
    .where("flatId", "==", flatId)
    .where("role", "==", "RESIDENT")
    .get();
  return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

async function registerStreet(communityId, streetName, createdByUid = "") {
  const name = safeString(streetName);
  if (!name) return null;
  const slug = normalizeStreetName(name);
  if (!slug) return null;
  const ref = db.doc(`communities/${communityId}/streets/${slug}`);
  await ref.set({
    id: slug,
    communityId,
    name,
    normalizedName: slug,
    isActive: true,
    updatedAtMs: nowMs(),
    createdAtMs: nowMs(),
    createdByUid
  }, { merge: true });
  return slug;
}

async function decrementSeatsUsed(communityId) {
  await db.doc(`communities/${communityId}`).set({
    seatsUsed: admin.firestore.FieldValue.increment(-1),
    updatedAtMs: nowMs()
  }, { merge: true });
}

async function incrementSeatsUsed(communityId) {
  await db.doc(`communities/${communityId}`).set({
    seatsUsed: admin.firestore.FieldValue.increment(1),
    updatedAtMs: nowMs()
  }, { merge: true });
}

async function ensureSeatAvailable(communityId) {
  const community = await getCommunity(communityId);
  const total = Number(community?.seatsTotal || 0);
  const used = Number(community?.seatsUsed || 0);
  if (total > 0 && used >= total) {
    throw new HttpsError("resource-exhausted", "Wykorzystano limit seats.");
  }
}

// =========================================================
// FCM HELPERS
// =========================================================

async function getUserToken(uid) {
  if (!uid) return null;
  const snap = await db.doc(`users/${uid}`).get();
  return snap.exists ? snap.data().fcmToken : null;
}

async function getCommunityAdmins(communityId) {
  const snap = await db.collection("users")
    .where("communityId", "==", communityId)
    .where("role", "in", ["ADMIN", "MASTER"])
    .get();
  return snap.docs.map(d => d.data().fcmToken).filter(Boolean);
}

async function sendToToken(token, type, title, body, extraData = {}) {
  if (!token) return;
  const message = {
    token,
    data: {
      type: String(type || ""),
      title: String(title || ""),
      body: String(body || ""),
      ...Object.fromEntries(Object.entries(extraData).map(([k, v]) => [k, String(v ?? "")]))
    },
    android: { priority: "high" }
  };
  try {
    await admin.messaging().send(message);
  } catch (e) {
    console.error("FCM Error:", e);
  }
}

async function sendToTokens(tokens, type, title, body, extraData = {}) {
  if (!tokens || tokens.length === 0) return;
  const message = {
    tokens,
    data: {
      type: String(type || ""),
      title: String(title || ""),
      body: String(body || ""),
      ...Object.fromEntries(Object.entries(extraData).map(([k, v]) => [k, String(v ?? "")]))
    }
  };
  try {
    await admin.messaging().sendEachForMulticast(message);
  } catch (e) {
    console.error("FCM Multicast Error:", e);
  }
}

async function sendToTopic(topic, type, title, body, extraData = {}) {
  const message = {
    topic,
    data: {
      type: String(type || ""),
      title: String(title || ""),
      body: String(body || ""),
      ...Object.fromEntries(Object.entries(extraData).map(([k, v]) => [k, String(v ?? "")]))
    }
  };
  try {
    await admin.messaging().send(message);
  } catch (e) {
    console.error("FCM Topic Error:", e);
  }
}

// =========================================================
// FIRESTORE TRIGGERS
// =========================================================

exports.onAnnouncementCreated = onDocumentCreated("communities/{communityId}/announcements/{announcementId}", async (event) => {
  const data = event.data.data();
  await sendToTopic(`community_${event.params.communityId}`, "announcement_admin", "Ogłoszenie administracji", data.title, { senderUid: data.createdByUid });
});

exports.onResidentAnnouncementCreated = onDocumentCreated("communities/{communityId}/residentAnnouncements/{announcementId}", async (event) => {
  const data = event.data.data();
  await sendToTopic(`community_${event.params.communityId}`, "announcement_new", "Nowe ogłoszenie lokatorskie", data.title, { senderUid: data.createdByUid });
});

exports.onChatMessageCreated = onDocumentCreated("communities/{communityId}/chatMessages/{messageId}", async (event) => {
  const data = event.data.data();
  await sendToTopic(`community_${event.params.communityId}`, "community_chat", data.senderName, data.text, { senderUid: data.senderUid });
});

exports.onTicketCreated = onDocumentCreated("communities/{communityId}/tickets/{ticketId}", async (event) => {
  const data = event.data.data();
  const adminTokens = await getCommunityAdmins(event.params.communityId);
  await sendToTokens(adminTokens, "ticket_new", "Nowa usterka", `${data.flatLabel || data.flatId || ""}: ${data.title}`, { senderUid: data.createdByUid });
});

exports.onTicketUpdated = onDocumentUpdated("communities/{communityId}/tickets/{ticketId}", async (event) => {
  const newData = event.data.after.data();
  const oldData = event.data.before.data();
  if (newData.status !== oldData.status) {
    const token = await getUserToken(newData.createdByUid);
    await sendToToken(token, "ticket_status", "Zmiana statusu usterki", `${newData.title}: ${newData.status}`, { senderUid: newData.updatedByUid });
  }
});

exports.onVoteCreated = onDocumentCreated("communities/{communityId}/votes/{voteId}", async (event) => {
  const data = event.data.data();
  await sendToTopic(`community_${event.params.communityId}`, "vote_new", "Nowe głosowanie", data.title, { senderUid: data.createdByUid });
});

exports.onCorrespondenceMessageCreated = onDocumentCreated("communities/{communityId}/correspondence/{resUid}/messages/{msgId}", async (event) => {
  const data = event.data.data();
  const resUid = event.params.resUid;
  if (data.senderUid === resUid) {
    const adminTokens = await getCommunityAdmins(event.params.communityId);
    await sendToTokens(adminTokens, "correspondence", "Wiadomość od lokatora", data.text, { senderUid: data.senderUid });
  } else {
    const token = await getUserToken(resUid);
    await sendToToken(token, "correspondence", "Wiadomość od administracji", data.text, { senderUid: data.senderUid });
  }
});

exports.onDueCreated = onDocumentCreated("communities/{communityId}/dues/{dueId}", async (event) => {
  const data = event.data.data();
  await sendToTopic(`community_${event.params.communityId}`, "due_created", "Nowa płatność", data.title, { senderUid: data.createdByUid });
});

async function notifySettlementPublished(communityId, settlementId, after, before = null) {
  if (!after?.isPublished || before?.isPublished === true) return;
  const residents = await getFlatResidents(communityId, after.flatId);
  const tokens = residents.map(r => r.fcmToken).filter(Boolean);

  await sendToTokens(
    tokens,
    "settlement_ready",
    "Nowe rozliczenie",
    `${after.period || ""} • ${after.flatLabel || after.flatId || ""}`,
    { settlementId, flatId: after.flatId || "", period: after.period || "" }
  );
}

exports.onSettlementPublished = onDocumentUpdated("communities/{communityId}/settlements/{settlementId}", async (event) => {
  await notifySettlementPublished(event.params.communityId, event.params.settlementId, event.data.after.data(), event.data.before.data());
});

exports.onSettlementCreated = onDocumentCreated("communities/{communityId}/settlements/{settlementId}", async (event) => {
  await notifySettlementPublished(event.params.communityId, event.params.settlementId, event.data.data(), null);
});

// =========================================================
// BASIC SYSTEM CALLABLES
// =========================================================

exports.createActivationCode = onCall(async (request) => {
  assertOwner(request);
  const data = request.data || {};
  const name = safeString(data.name || data.orgName);
  const nip = String(data.nip || "").replace(/\D/g, "");
  if (!name || nip.length !== 10) {
    throw new HttpsError("invalid-argument", "Podaj nazwę i poprawny NIP.");
  }

  for (let i = 0; i < 10; i++) {
    const code = randomCode(10);
    const ref = db.doc(`activation_codes/${code}`);
    try {
      await ref.create({
        code,
        name,
        nip,
        used: false,
        status: "ACTIVE",
        createdAtMs: nowMs(),
        createdByUid: request.auth.uid
      });
      return { code, docPath: ref.path };
    } catch (e) {
      if (e.code !== 6) throw e;
    }
  }
  throw new HttpsError("resource-exhausted", "Błąd generowania kodu.");
});

exports.activateCommunity = onCall(async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Zaloguj się.");
  const { code, nip, name } = request.data || {};
  if (!safeString(code) || !safeString(nip) || !safeString(name)) {
    throw new HttpsError("invalid-argument", "Brak danych aktywacji.");
  }

  const communityRef = db.collection("communities").doc();

  return await db.runTransaction(async (tx) => {
    const codeRef = db.doc(`activation_codes/${code}`);
    const codeSnap = await tx.get(codeRef);
    if (!codeSnap.exists) throw new HttpsError("not-found", "Kod nie istnieje.");
    if (codeSnap.data().used === true) throw new HttpsError("failed-precondition", "Kod już użyty.");

    tx.set(communityRef, {
      id: communityRef.id,
      name: safeString(name),
      nip: String(nip).replace(/\D/g, ""),
      createdAtMs: nowMs(),
      updatedAtMs: nowMs(),
      panelAccessEnabled: true,
      enableExternalPayments: false,
      paymentsUrl: "",
      seatsTotal: 2,
      seatsUsed: 0
    });

    tx.set(db.doc(`users/${request.auth.uid}`), {
      role: "MASTER",
      communityId: communityRef.id,
      customerId: communityRef.id,
      updatedAtMs: nowMs()
    }, { merge: true });

    tx.update(codeRef, {
      used: true,
      usedAtMs: nowMs(),
      communityId: communityRef.id
    });

    return { ok: true, communityId: communityRef.id };
  });
});

exports.createInvite = onCall(async (request) => {
  const me = await assertSignedIn(request);
  const data = request.data || {};
  const invite = {
    customerId: me.customerId || me.communityId,
    communityId: me.communityId,
    role: safeString(data.role || "RESIDENT"),
    status: "active",
    createdAtMs: nowMs(),
    expiresAtMs: Number(data.expiresAtMs || 0)
  };
  const ref = await db.collection("invites").add(invite);
  return { ok: true, inviteId: ref.id };
});

exports.claimInvite = onCall(async (request) => {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Zaloguj się.");
  const inviteId = safeString(request.data?.inviteId);
  if (!inviteId) throw new HttpsError("invalid-argument", "Brak inviteId.");

  return await db.runTransaction(async (tx) => {
    const inviteRef = db.doc(`invites/${inviteId}`);
    const snap = await tx.get(inviteRef);
    if (!snap.exists) throw new HttpsError("not-found", "Invite nie istnieje.");
    const inv = snap.data();
    tx.set(db.doc(`users/${request.auth.uid}`), {
      role: inv.role,
      communityId: inv.communityId,
      customerId: inv.customerId,
      updatedAtMs: nowMs()
    }, { merge: true });
    tx.update(inviteRef, {
      status: "used",
      usedByUid: request.auth.uid,
      usedAtMs: nowMs()
    });
    return { ok: true };
  });
});

async function ensureCommunityJoinCode(communityId, role) {
  const code = randomCode(10);
  const ref = db.doc(`join_codes/${code}`);
  await ref.create({
    code,
    communityId,
    role,
    createdAtMs: nowMs(),
    status: "ACTIVE"
  });
  return code;
}

exports.createJoinCode = onCall(async (request) => {
  const me = await assertAdminOrMaster(request);
  const role = safeString(request.data?.role || "ACCOUNTANT").toUpperCase();
  if (!["ACCOUNTANT", "ADMIN", "RESIDENT"].includes(role)) {
    throw new HttpsError("invalid-argument", "Nieobsługiwana rola.");
  }
  const communityId = safeString(request.data?.communityId || me.communityId);
  await assertSameCommunity(me, communityId);
  const code = await ensureCommunityJoinCode(communityId, role);
  return { ok: true, code, communityId, role };
});

exports.claimJoinCode = onCall(async (request) => {
  const me = await assertSignedIn(request);
  const code = safeString(request.data?.code);
  if (!code) throw new HttpsError("invalid-argument", "Podaj kod.");

  const ref = db.doc(`join_codes/${code}`);
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Kod nie istnieje.");
    const jc = snap.data();
    if (jc.status !== "ACTIVE") throw new HttpsError("failed-precondition", "Kod nieważny.");

    tx.update(ref, {
      status: "USED",
      usedAtMs: nowMs(),
      usedByUid: request.auth.uid
    });

    tx.set(db.doc(`users/${request.auth.uid}`), {
      role: jc.role,
      communityId: jc.communityId,
      customerId: jc.communityId,
      updatedAtMs: nowMs(),
      staffSeat: true
    }, { merge: true });

    return { ok: true, communityId: jc.communityId, role: jc.role };
  });
});

exports.createWebSession = onCall(async (request) => {
  const me = await assertSignedIn(request);
  const token = randomToken(48);
  const target = safeString(request.data?.target || "/payments");
  const expiresAtMs = nowMs() + 2 * 60 * 1000;

  await db.doc(`webSessions/${token}`).set({
    token,
    uid: request.auth.uid,
    communityId: me.communityId || "",
    createdAtMs: nowMs(),
    expiresAtMs,
    used: false,
    target
  });

  return { ok: true, token, expiresAtMs, target };
});

exports.consumeWebSession = onCall(async (request) => {
  const token = safeString(request.data?.token);
  if (!token) throw new HttpsError("invalid-argument", "Brak token.");

  return await db.runTransaction(async (tx) => {
    const ref = db.doc(`webSessions/${token}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Token nie istnieje.");
    const s = snap.data();
    if (s.used) throw new HttpsError("failed-precondition", "Token zużyty.");
    if (nowMs() > Number(s.expiresAtMs || 0)) throw new HttpsError("failed-precondition", "Token wygasł.");
    tx.update(ref, { used: true, usedAtMs: nowMs() });
    const customToken = await admin.auth().createCustomToken(String(s.uid));
    return { ok: true, customToken, uid: s.uid, target: s.target || "/payments" };
  });
});

// =========================================================
// USER / STREET / SEATS CALLABLES
// =========================================================

exports.removeUser = onCall(async (request) => {
  const me = await assertAdminOrMaster(request);
  const targetUid = safeString(request.data?.targetUid);
  if (!targetUid) throw new HttpsError("invalid-argument", "Brak targetUid.");
  if (targetUid === request.auth.uid) throw new HttpsError("failed-precondition", "Nie możesz usunąć samego siebie.");

  const targetRef = db.doc(`users/${targetUid}`);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) throw new HttpsError("not-found", "Użytkownik nie istnieje.");

  const target = targetSnap.data();
  if (target.communityId !== me.communityId) throw new HttpsError("permission-denied", "Inna wspólnota.");

  await targetRef.set({
    role: "REMOVED",
    appBlocked: true,
    flatId: admin.firestore.FieldValue.delete(),
    flatLabel: admin.firestore.FieldValue.delete(),
    staircaseId: admin.firestore.FieldValue.delete(),
    street: admin.firestore.FieldValue.delete(),
    buildingNo: admin.firestore.FieldValue.delete(),
    apartmentNo: admin.firestore.FieldValue.delete(),
    removedAtMs: nowMs(),
    removedByUid: request.auth.uid
  }, { merge: true });

  return { ok: true };
});

exports.setUserBlocked = onCall(async (request) => {
  const me = await assertAdminOrMaster(request);
  const targetUid = safeString(request.data?.targetUid);
  const blocked = request.data?.blocked === true;
  if (!targetUid) throw new HttpsError("invalid-argument", "Brak targetUid.");

  const targetRef = db.doc(`users/${targetUid}`);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) throw new HttpsError("not-found", "Użytkownik nie istnieje.");
  const target = targetSnap.data();
  if (target.communityId !== me.communityId) throw new HttpsError("permission-denied", "Inna wspólnota.");

  await targetRef.set({
    appBlocked: blocked,
    updatedAtMs: nowMs(),
    updatedByUid: request.auth.uid
  }, { merge: true });

  return { ok: true };
});

exports.addStreet = onCall(async (request) => {
  const me = await assertMaster(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const name = safeString(request.data?.name || request.data?.street);
  await assertSameCommunity(me, communityId);
  if (!name) throw new HttpsError("invalid-argument", "Brak nazwy ulicy.");

  const streetId = await registerStreet(communityId, name, request.auth.uid);
  return { ok: true, streetId, name };
});

exports.removeFlatSafe = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const flatId = safeString(request.data?.flatId);
  await assertSameCommunity(me, communityId);
  if (!flatId) throw new HttpsError("invalid-argument", "Brak flatId.");

  const flatRef = db.doc(`communities/${communityId}/flats/${flatId}`);
  const flatSnap = await flatRef.get();
  if (!flatSnap.exists) throw new HttpsError("not-found", "Brak lokalu.");

  const residents = await getFlatResidents(communityId, flatId);
  for (const res of residents) {
    await db.doc(`users/${res.uid}`).set({
      role: "REMOVED",
      appBlocked: true,
      flatId: admin.firestore.FieldValue.delete(),
      flatLabel: admin.firestore.FieldValue.delete(),
      removedAtMs: nowMs(),
      removedByUid: request.auth.uid
    }, { merge: true });
  }

  await flatRef.delete();
  await decrementSeatsUsed(communityId);

  return { ok: true };
});

// =========================================================
// KSeF / XML / OCR HELPERS
// =========================================================

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_"
});

function parseInvoiceXmlBasic(xml) {
  const parsed = xmlParser.parse(xml);
  const raw = JSON.stringify(parsed);
  const totalCandidates = raw.match(/(\d+[\.,]\d{2})/g) || [];
  const total = totalCandidates.length ? totalCandidates[totalCandidates.length - 1] : "0.00";
  const dateMatch = raw.match(/(20\d{2}-\d{2}-\d{2})/);
  const issueDate = dateMatch ? dateMatch[1] : "";
  return {
    issueDate,
    period: monthFromDateStr(issueDate),
    totalGrossCents: toCents(total),
    currency: "PLN",
    sellerName: "",
    buyerName: "",
    ksefNumber: "",
    items: []
  };
}

async function extractPdfText(base64Pdf) {
  if (!pdfParse) {
    throw new HttpsError("failed-precondition", "Brak pdf-parse w functions. Doinstaluj pdf-parse.");
  }
  const buffer = Buffer.from(String(base64Pdf || ""), "base64");
  const parsed = await pdfParse(buffer);
  return String(parsed?.text || "").replace(/\u0000/g, " ").trim();
}

// =========================================================
// AI HELPERS
// =========================================================

function heuristicCategory(text) {
  const t = normalizeLookup(text);
  if (/woda|sciek|kanal|wodociag/.test(t)) return "WODA";
  if (/gaz/.test(t)) return "GAZ";
  if (/energia|prad|tauron|enea|energa|pge/.test(t)) return "PRAD";
  if (/sprzatan|czystosc|utrzymanie porzadku/.test(t)) return "SPRZATANIE";
  if (/remont|napraw|modern|serwis|hydraul|elektryk/.test(t)) return "REMONT";
  return "INNE";
}

function detectInvoiceScope(invoiceText, hintedScope = "") {
  const direct = safeString(hintedScope).toUpperCase();
  if (["FLAT", "BUILDING", "STAIRCASE", "COMMON", "COMMUNITY"].includes(direct)) {
    return { scope: direct, confidence: 0.99, reason: "Zakres wynika z jawnego przypisania." };
  }

  const text = safeString(invoiceText);
  const normalized = normalizeLookup(text);
  const hints = parseAddressHints(text);
  const explicitFlatNo = !!hints.apartmentNo || /(?:nr\s+lokalu|lokal(?:u)?|mieszkanie|adres\s+lokalu|\/\d+[a-z]?)/i.test(text);
  const communityScore = /(?:cala?\s+wspolnot|wszystkie\s+budynki|cale\s+osiedle|osiedl|wspolnota\s+mieszkaniow|zarzad\s+wspolnoty)/.test(normalized) ? 1 : 0;
  const commonScore = /(?:czesc\s+wspoln|czesci\s+wspoln|nieruchomosc\s+wspoln|fundusz\s+remontowy|sprzatanie\s+klatek|oswietlenie\s+klatki|pion\s+wentylacyjny|pion\s+kanal|winda|teren\s+wspoln|garaz\s+wspoln)/.test(normalized) ? 1 : 0;
  const staircaseScore = /(?:klatka|kl\.|staircase|entrance|pion)/.test(normalized) ? 1 : 0;
  const buildingScore = /(?:budynek|adres\s+obiektu|adres\s+dostawy|punkt\s+poboru|obiekt)/.test(normalized) ? 1 : 0;
  const flatScore = /(?:lokal(?:u)?|mieszkanie|nr\s+lokalu|adres\s+lokalu|odbiorca\s+uslugi)/.test(normalized) ? 1 : 0;

  if (communityScore) return { scope: "COMMUNITY", confidence: 0.94, reason: "Tekst wskazuje na koszt całej wspólnoty / osiedla." };
  if (commonScore && staircaseScore && hints.staircaseId) return { scope: "COMMON", confidence: 0.92, reason: "Tekst wskazuje na część wspólną przypisaną do klatki / pionu." };
  if (commonScore && (buildingScore || hints.buildingNo)) return { scope: "COMMON", confidence: 0.9, reason: "Tekst wskazuje na część wspólną budynku." };
  if (commonScore) return { scope: "COMMON", confidence: 0.88, reason: "Tekst wskazuje na koszt części wspólnej." };
  if (staircaseScore && hints.staircaseId && !explicitFlatNo) return { scope: "STAIRCASE", confidence: 0.86, reason: "Tekst wskazuje na konkretną klatkę / pion." };
  if (buildingScore && !explicitFlatNo) return { scope: "BUILDING", confidence: 0.82, reason: "Tekst wskazuje na konkretny budynek." };
  if (flatScore && explicitFlatNo) return { scope: "FLAT", confidence: 0.84, reason: "Tekst zawiera jednoznaczny numer lokalu." };
  if (explicitFlatNo && !commonScore && !communityScore) return { scope: "FLAT", confidence: 0.8, reason: "Rozpoznano numer lokalu w adresie." };
  if (hints.buildingNo) return { scope: "BUILDING", confidence: 0.66, reason: "Rozpoznano adres budynku." };
  return { scope: "COMMON", confidence: 0.5, reason: "Brak jednoznacznych danych — przyjęto koszt wspólny do weryfikacji." };
}

async function askAiForJson(prompt, model = null, fallback = null) {
  const client = getOpenAIClient();
  if (!client) return fallback;

  try {
    const resp = await client.chat.completions.create({
      model: model || process.env.OPENAI_MODEL_FAST || "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      response_format: { type: "json_object" }
    });

    const content = resp.choices?.[0]?.message?.content || "";
    return JSON.parse(content);
  } catch (e) {
    console.error("OpenAI error:", e);
    return fallback;
  }
}

async function aiSuggestInvoice(invoiceText) {
  const scopeHint = detectInvoiceScope(invoiceText);
  const prompt = [
    "Jesteś asystentem księgowej wspólnoty mieszkaniowej.",
    "Zwróć wyłącznie JSON:",
    "{",
    '  "category":"PRAD|WODA|GAZ|SPRZATANIE|REMONT|INNE",',
    '  "scope":"FLAT|BUILDING|STAIRCASE|COMMON|COMMUNITY",',
    '  "period":"YYYY-MM",',
    '  "confidence":0.0,',
    '  "needsReview":true,',
    '  "reason":"..."',
    "}",
    "",
    `Wstępna heurystyka zakresu: ${scopeHint.scope} (${scopeHint.reason})`,
    "FAKTURA:",
    invoiceText
  ].join("\n");

  return await askAiForJson(prompt, process.env.OPENAI_MODEL_FAST || "gpt-4o-mini", {
    category: heuristicCategory(invoiceText),
    scope: scopeHint.scope,
    period: monthFromDateStr((String(invoiceText || "").match(/20\d{2}-\d{2}-\d{2}/) || [])[0] || ""),
    confidence: scopeHint.confidence,
    needsReview: true,
    reason: scopeHint.reason,
  });
}

async function aiExplainReview(input) {
  const prompt = [
    "Wyjaśnij księgowej prostym językiem, dlaczego sprawa trafiła do review queue.",
    "Zwróć wyłącznie JSON:",
    "{",
    '  "summary":"...",',
    '  "reason":"...",',
    '  "recommendedChecks":["...", "..."]',
    "}",
    "",
    JSON.stringify(input)
  ].join("\n");

  return await askAiForJson(prompt, process.env.OPENAI_MODEL_SMART || process.env.OPENAI_MODEL_FAST || "gpt-4o-mini", null);
}

async function aiMatchPayment({ title, amount, candidates }) {
  const prompt = [
    "Dopasuj przelew do najlepszego kandydata.",
    "Zwróć wyłącznie JSON:",
    "{",
    '  "suggestedFlatId":"...",',
    '  "suggestedSettlementId":"...",',
    '  "confidence":0.0,',
    '  "needsReview":true,',
    '  "reason":"..."',
    "}",
    "",
    `Tytuł: ${title}`,
    `Kwota: ${amount}`,
    `Kandydaci: ${JSON.stringify(candidates)}`
  ].join("\n");

  return await askAiForJson(prompt, process.env.OPENAI_MODEL_FAST || "gpt-4o-mini", null);
}

async function aiAnalyzeMeter({ currentValue, prevValue, meterType, unit, flatLabel }) {
  const prompt = [
    "Oceń czy odczyt licznika wygląda podejrzanie.",
    "Zwróć wyłącznie JSON:",
    "{",
    '  "anomaly":true,',
    '  "confidence":0.0,',
    '  "needsReview":true,',
    '  "reason":"..."',
    "}",
    "",
    `Typ licznika: ${meterType}`,
    `Jednostka: ${unit}`,
    `Lokal: ${flatLabel}`,
    `Poprzedni odczyt: ${prevValue}`,
    `Nowy odczyt: ${currentValue}`
  ].join("\n");

  return await askAiForJson(prompt, process.env.OPENAI_MODEL_FAST || "gpt-4o-mini", null);
}

// =========================================================
// REVIEW QUEUE HELPERS
// =========================================================

async function createReviewItem(communityId, data) {
  const ref = await db.collection(`communities/${communityId}/reviewQueue`).add({
    status: "OPEN",
    createdAtMs: nowMs(),
    ...data
  });
  return ref.id;
}

// =========================================================
// KSeF / OCR / AI FACTURE FLOW
// =========================================================

function normalizeKsefSignatureParts(parts = []) {
  return parts.map((part) => normalizeLookup(part)).filter(Boolean).join("|");
}

function buildKsefDedupeKeys(input = {}) {
  const sellerName = safeString(input.sellerName || input.parsed?.sellerName || input.vendorName);
  const sellerNip = safeString(input.sellerNip || input.parsed?.sellerNip || input.nip).replace(/\D/g, "");
  const issueDate = safeString(input.issueDate || input.parsed?.issueDate);
  const amount = Number(input.totalGrossCents || input.parsed?.totalGrossCents || input.amountCents || 0);
  const invoiceNumber = safeString(input.invoiceNumber || input.parsed?.invoiceNumber);
  const ksefNumber = safeString(input.ksefNumber || input.parsed?.ksefNumber);
  const period = safeString(input.period || input.parsed?.period);
  const keys = new Set();
  const base = normalizeKsefSignatureParts([sellerName, sellerNip, issueDate, amount, invoiceNumber, period]);
  if (base) keys.add(`BASE:${base}`);
  const fallback = normalizeKsefSignatureParts([sellerName, issueDate, amount, period]);
  if (fallback) keys.add(`FALLBACK:${fallback}`);
  if (invoiceNumber) keys.add(`INV:${normalizeLookup(invoiceNumber)}`);
  if (ksefNumber) keys.add(`KSEF:${normalizeLookup(ksefNumber)}`);
  return Array.from(keys);
}

async function findDuplicateKsefInvoice(communityId, dedupeKeys = []) {
  for (const key of dedupeKeys) {
    const snap = await db.collection(`communities/${communityId}/ksefInvoices`).where("dedupeKeys", "array-contains", key).limit(1).get();
    if (!snap.empty) return snap.docs[0];
  }
  return null;
}

async function saveKsefSyncState(communityId, patch) {
  await db.doc(`communities/${communityId}/ksef/config`).set({
    ...patch,
    updatedAtMs: nowMs(),
  }, { merge: true });
}

async function performKsefFetchForCommunity(communityId, options = {}) {
  const cfgRef = db.doc(`communities/${communityId}/ksef/config`);
  const cfgSnap = await cfgRef.get();
  const cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
  const mode = safeString(options.mode || cfg.environment || cfg.mode || "MOCK").toUpperCase();
  const count = Math.max(1, Math.min(20, Number(options.count || cfg.autoSyncCount || 5)));
  const issueDate = safeString(options.issueDate || cfg.issueDate || "2026-03-01");
  const sellerName = mode === "MOCK" ? "TAURON" : "KSeF import";
  const created = [];
  const duplicates = [];

  if (cfg.syncInProgress === true && Number(cfg.lastSyncStartedAtMs || 0) > nowMs() - 30 * 60 * 1000) {
    return { ok: true, skipped: true, reason: "SYNC_IN_PROGRESS", created, duplicates, mode };
  }

  await saveKsefSyncState(communityId, {
    syncInProgress: true,
    lastSyncStartedAtMs: nowMs(),
    lastSyncMode: mode,
  });

  try {
    for (let i = 0; i < count; i++) {
      const total = Number((1234.56 + i).toFixed(2));
      const totalGrossCents = toCents(total);
      const ksefNumber = `${mode === "MOCK" ? "MOCK" : "KSEF"}-${issueDate}-${i + 1}`;
      const invoiceNumber = `${mode === "MOCK" ? "FV-MOCK" : "FV-KSEF"}/${issueDate.replace(/-/g, "")}/${i + 1}`;
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice>
  <KSeFNumber>${ksefNumber}</KSeFNumber>
  <IssueDate>${issueDate}</IssueDate>
  <Seller><Name>${sellerName}</Name><NIP>1234567890</NIP></Seller>
  <Buyer><Name>Wspólnota ${communityId}</Name><NIP>${safeString(cfg?.nip || options.nip || "")}</NIP></Buyer>
  <InvoiceNumber>${invoiceNumber}</InvoiceNumber>
  <Total>${total.toFixed(2)}</Total>
  <Items><Item><Name>Energia elektryczna</Name><Amount>${total.toFixed(2)}</Amount></Item></Items>
</Invoice>`;

      const parsed = parseInvoiceXmlBasic(xml);
      parsed.invoiceNumber = safeString(parsed.invoiceNumber || invoiceNumber);
      parsed.totalGrossCents = Number(parsed.totalGrossCents || totalGrossCents);
      parsed.period = safeString(parsed.period || monthFromDateStr(issueDate));
      const dedupeKeys = cfg.dedupeEnabled === false ? [] : buildKsefDedupeKeys({
        sellerName,
        sellerNip: "1234567890",
        issueDate,
        totalGrossCents: parsed.totalGrossCents,
        invoiceNumber: parsed.invoiceNumber,
        ksefNumber,
        period: parsed.period,
        parsed,
      });
      const duplicateSnap = dedupeKeys.length ? await findDuplicateKsefInvoice(communityId, dedupeKeys) : null;
      if (duplicateSnap) {
        await duplicateSnap.ref.set({
          updatedAtMs: nowMs(),
          duplicateBlockedAtMs: nowMs(),
          dedupeKeys,
          duplicateSource: mode,
          lastFetchAttemptAtMs: nowMs(),
        }, { merge: true });
        duplicates.push({ id: duplicateSnap.id, ksefNumber, invoiceNumber: parsed.invoiceNumber });
        continue;
      }

      const ref = await db.collection(`communities/${communityId}/ksefInvoices`).add({
        createdAtMs: nowMs(),
        updatedAtMs: nowMs(),
        status: "NOWA",
        source: mode === "MOCK" ? "MOCK" : "KSEF",
        xml,
        parsed,
        invoiceNumber: parsed.invoiceNumber,
        totalGrossCents: parsed.totalGrossCents,
        ksefNumber,
        dedupeKeys,
        assigned: { scope: null },
        ai: { status: "PENDING" },
        fetchedFromKsefAtMs: nowMs(),
        fetchAttempt: Number(cfg.retryAttempts || 0) + 1,
        ksefConfigSnapshot: {
          mode,
          environment: mode,
          identifier: safeString(cfg?.identifier || ""),
          nip: safeString(cfg?.nip || ""),
        }
      });
      created.push({ id: ref.id, ksefNumber, invoiceNumber: parsed.invoiceNumber });
    }

    await saveKsefSyncState(communityId, {
      syncInProgress: false,
      lastSyncAtMs: nowMs(),
      lastSyncSuccessAtMs: nowMs(),
      lastSyncError: "",
      retryAttempts: 0,
      nextRetryAtMs: null,
      lastSyncCreated: created.length,
      lastSyncDuplicates: duplicates.length,
    });

    return { ok: true, created, duplicates, mode };
  } catch (error) {
    const retryEnabled = cfg.retryEnabled !== false;
    const retryAttempts = Number(cfg.retryAttempts || 0) + 1;
    const retryMaxAttempts = Math.max(1, Number(cfg.retryMaxAttempts || 3));
    const retryDelayMinutes = Math.max(5, Number(cfg.retryDelayMinutes || 15));
    const shouldRetry = retryEnabled && retryAttempts <= retryMaxAttempts;
    await saveKsefSyncState(communityId, {
      syncInProgress: false,
      lastSyncError: safeString(error?.message || error),
      lastSyncFailedAtMs: nowMs(),
      retryAttempts,
      nextRetryAtMs: shouldRetry ? nowMs() + retryDelayMinutes * 60 * 1000 : null,
    });
    throw error;
  }
}

function shouldRunKsefSyncNow(cfg = {}) {
  if (cfg.autoSyncEnabled !== true) return false;
  if (cfg.syncInProgress === true && Number(cfg.lastSyncStartedAtMs || 0) > nowMs() - 30 * 60 * 1000) return false;
  const now = nowMs();
  const nextRetryAtMs = Number(cfg.nextRetryAtMs || 0);
  if (nextRetryAtMs && nextRetryAtMs <= now) return true;
  const intervalMinutes = Math.max(15, Number(cfg.autoSyncIntervalMinutes || 60));
  const lastSyncAtMs = Number(cfg.lastSyncAtMs || 0);
  if (!lastSyncAtMs) return true;
  return lastSyncAtMs + intervalMinutes * 60 * 1000 <= now;
}

exports.ksefSetConfig = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  await assertSameCommunity(me, communityId);

  const environment = safeString(request.data?.environment || request.data?.mode || "MOCK").toUpperCase();
  await db.doc(`communities/${communityId}/ksef/config`).set({
    mode: environment,
    environment,
    identifier: safeString(request.data?.identifier || request.data?.nip || ""),
    nip: safeString(request.data?.nip || request.data?.identifier || "").replace(/\D/g, ""),
    token: safeString(request.data?.token || ""),
    subjectType: safeString(request.data?.subjectType || "Subject2"),
    syncFrom: safeString(request.data?.syncFrom || ""),
    syncTo: safeString(request.data?.syncTo || ""),
    autoSyncEnabled: request.data?.autoSyncEnabled === true,
    autoSyncIntervalMinutes: Math.max(15, Number(request.data?.autoSyncIntervalMinutes || 60)),
    autoSyncCount: Math.max(1, Math.min(20, Number(request.data?.autoSyncCount || 5))),
    retryEnabled: request.data?.retryEnabled !== false,
    retryMaxAttempts: Math.max(1, Math.min(10, Number(request.data?.retryMaxAttempts || 3))),
    retryDelayMinutes: Math.max(5, Math.min(1440, Number(request.data?.retryDelayMinutes || 15))),
    dedupeEnabled: request.data?.dedupeEnabled !== false,
    updatedAtMs: nowMs(),
    updatedByUid: request.auth.uid
  }, { merge: true });

  return { ok: true };
});

exports.ksefFetchInvoices = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  await assertSameCommunity(me, communityId);

  return await performKsefFetchForCommunity(communityId, {
    mode: request.data?.mode,
    count: request.data?.count,
    issueDate: request.data?.issueDate,
    nip: request.data?.nip,
  });
});

exports.ksefRunAutoSync = onSchedule({ schedule: "every 15 minutes", timeZone: "Europe/Warsaw", region: "europe-west1" }, async () => {
  const communitiesSnap = await db.collection("communities").get();
  let processed = 0;
  let success = 0;
  let failed = 0;

  for (const communityDoc of communitiesSnap.docs) {
    const communityId = communityDoc.id;
    const cfgSnap = await db.doc(`communities/${communityId}/ksef/config`).get();
    const cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
    if (!shouldRunKsefSyncNow(cfg)) continue;
    processed += 1;
    try {
      await performKsefFetchForCommunity(communityId, {
        mode: cfg.environment || cfg.mode,
        count: cfg.autoSyncCount,
      });
      success += 1;
    } catch (error) {
      failed += 1;
      console.error("ksefRunAutoSync failed", communityId, error?.message || error);
    }
  }

  return { processed, success, failed };
});


exports.clearSettlementDrafts = onCall(async (request) => {
  const communityId = safeString(request.data?.communityId);
  if (!communityId) throw new HttpsError("invalid-argument", "Brak communityId.");

  const caller = await getCallerProfile(request.auth?.uid);
  assertPanelRole(caller);
  if (!sameCommunity(caller, communityId) && !isOwnerEmail(caller?.email)) {
    throw new HttpsError("permission-denied", "Brak dostępu do tej wspólnoty.");
  }

  const snap = await db.collection(`communities/${communityId}/settlementDrafts`).get();
  if (snap.empty) return { ok: true, deleted: 0 };

  let deleted = 0;
  let batch = db.batch();
  let ops = 0;
  for (const d of snap.docs) {
    batch.delete(d.ref);
    deleted += 1;
    ops += 1;
    if (ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return { ok: true, deleted };
});

exports.ksefRetryNow = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  await assertSameCommunity(me, communityId);
  return await performKsefFetchForCommunity(communityId, {
    mode: request.data?.mode,
    count: request.data?.count,
    issueDate: request.data?.issueDate,
    nip: request.data?.nip,
  });
});

exports.ksefParseInvoice = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const invoiceId = safeString(request.data?.invoiceId);
  await assertSameCommunity(me, communityId);
  if (!invoiceId) throw new HttpsError("invalid-argument", "Brak invoiceId.");

  const ref = db.doc(`communities/${communityId}/ksefInvoices/${invoiceId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Faktura nie istnieje.");

  const xml = safeString(snap.data().xml);
  const parsed = parseInvoiceXmlBasic(xml);

  await ref.set({
    parsed,
    parsedAtMs: nowMs()
  }, { merge: true });

  return { ok: true, parsed };
});

exports.aiParseInvoicePdf = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const fileBase64 = safeString(request.data?.fileBase64);
  const filename = safeString(request.data?.filename || "invoice.pdf");
  await assertSameCommunity(me, communityId);
  if (!fileBase64) throw new HttpsError("invalid-argument", "Brak pliku PDF.");

  const text = await extractPdfText(fileBase64);
  const scopeHint = detectInvoiceScope(text);
  const heuristic = {
    category: heuristicCategory(text),
    scope: scopeHint.scope,
    period: monthFromDateStr((text.match(/20\d{2}-\d{2}-\d{2}/) || [])[0] || ""),
    confidence: Math.max(0.55, Number(scopeHint.confidence || 0)),
    needsReview: true,
    reason: scopeHint.reason || "Heurystyka OCR/PDF"
  };

  const ai = await aiSuggestInvoice(text);
  const suggestion = ai || heuristic;

  const ref = await db.collection(`communities/${communityId}/ksefInvoices`).add({
    createdAtMs: nowMs(),
    status: "NOWA",
    source: "PDF_OCR",
    filename,
    extractedText: text,
    parsed: {
      issueDate: "",
      period: suggestion.period || "",
      totalGrossCents: 0,
      currency: "PLN",
      sellerName: "",
      buyerName: "",
      ksefNumber: "",
      items: []
    },
    assigned: { scope: null },
    ai: {
      status: "READY",
      suggestion,
      suggestedAtMs: nowMs(),
      by: ai ? "AI" : "HEURISTIC"
    }
  });

  if (suggestion.needsReview || Number(suggestion.confidence || 0) < 0.85) {
    await createReviewItem(communityId, {
      type: "INVOICE_PDF",
      invoiceId: ref.id,
      title: `OCR faktury: ${filename}`,
      reason: suggestion.reason || "Wymaga sprawdzenia",
      confidence: Number(suggestion.confidence || 0)
    });
  }

  return { ok: true, invoiceId: ref.id, suggestion };
});

exports.aiSuggestInvoice = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const invoiceId = safeString(request.data?.invoiceId);
  await assertSameCommunity(me, communityId);
  if (!invoiceId) throw new HttpsError("invalid-argument", "Brak invoiceId.");

  let ref = db.doc(`communities/${communityId}/invoices/${invoiceId}`);
  let snap = await ref.get();
  if (!snap.exists) {
    ref = db.doc(`communities/${communityId}/ksefInvoices/${invoiceId}`);
    snap = await ref.get();
  }
  if (!snap.exists) throw new HttpsError("not-found", "Faktura nie istnieje.");

  const inv = snap.data();
  const invoiceStatus = safeString(inv.status).toUpperCase();
  if (invoiceStatus === "PRZENIESIONA_DO_SZKICU" || invoiceStatus === "ARCHIVED") {
    throw new HttpsError("already-exists", "Ta faktura została już wcześniej przeniesiona do szkicu rozliczeń.");
  }
  const parsed = inv.parsed || {};
  const invoiceText = [
    inv.ksefNumber || "",
    parsed.sellerName || "",
    parsed.buyerName || "",
    JSON.stringify(parsed.items || []),
    inv.extractedText || ""
  ].join(" ");

  let suggestion = await aiSuggestInvoice(invoiceText);
  if (!suggestion) {
    suggestion = {
      category: heuristicCategory(invoiceText),
      scope: "COMMON",
      period: parsed.period || "",
      confidence: 0.55,
      needsReview: true,
      reason: "Heurystyka słownikowa"
    };
  }

  await ref.set({
    ai: {
      status: "READY",
      suggestion,
      suggestedAtMs: nowMs(),
      by: suggestion.reason === "Heurystyka słownikowa" ? "HEURISTIC" : "AI"
    }
  }, { merge: true });

  if (suggestion.needsReview || Number(suggestion.confidence || 0) < 0.85) {
    await createReviewItem(communityId, {
      type: "INVOICE_ASSIGNMENT",
      invoiceId,
      title: `Weryfikacja faktury ${invoiceId}`,
      reason: suggestion.reason || "Wymaga sprawdzenia",
      confidence: Number(suggestion.confidence || 0)
    });
  }

  return { ok: true, suggestion };
});

// =========================================================
// APPROVAL / CHARGES / SETTLEMENTS
// =========================================================

async function recalcSettlement(communityId, flatId, period) {
  const flat = await getFlat(communityId, flatId);
  if (!flat) throw new HttpsError("not-found", "Brak lokalu.");

  const chargesSnap = await db.collection(`communities/${communityId}/charges`)
    .where("flatId", "==", flatId)
    .where("period", "==", period)
    .get();

  const paymentsSnap = await db.collection(`communities/${communityId}/payments`)
    .where("flatId", "==", flatId)
    .where("period", "==", period)
    .get();

  const charges = chargesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const payments = paymentsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const totalChargesCents = charges.reduce((s, x) => s + Number(x.amountCents || 0), 0);
  const totalPaymentsCents = payments.reduce((s, x) => s + Number(x.amountCents || 0), 0);
  const balanceCents = totalChargesCents - totalPaymentsCents;

  const community = await getCommunity(communityId);
  const defaults = readCommunityPaymentDefaults(community);
  const settlementId = settlementDocId(flatId, period);
  const state = await getSettlementState(communityId, settlementId);
  const existing = state.draft || state.published || {};
  const paymentRef = await buildPaymentTitle({ ...flat, communityId, id: flatId }, period, existing?.paymentRef || existing?.paymentTitle || existing?.transferTitle || "");

  await state.draftRef.set({
    id: settlementId,
    communityId,
    flatId,
    flatLabel: valueOr(flat.flatLabel, `${flat.street || ""} ${flat.buildingNo || ""}/${flat.apartmentNo || ""}`.trim()),
    street: flat.street || "",
    buildingNo: flat.buildingNo || "",
    apartmentNo: flat.apartmentNo || "",
    period,
    paymentRef,
    paymentTitle: paymentRef,
    paymentCode: paymentRef,
    transferTitle: paymentRef,
    totalChargesCents,
    chargesCents: totalChargesCents,
    totalPaymentsCents,
    paymentsCents: totalPaymentsCents,
    balanceCents,
    totalDueCents: balanceCents,
    dueDate: `${period}-15`,
    transferName: valueOr(existing?.transferName, valueOr(flat.recipientName, defaults.recipientName)),
    receiverName: valueOr(existing?.receiverName, valueOr(flat.receiverName, valueOr(flat.recipientName, defaults.recipientName))),
    transferAddress: valueOr(existing?.transferAddress, valueOr(flat.recipientAddress, defaults.recipientAddress)),
    receiverAddress: valueOr(existing?.receiverAddress, valueOr(flat.receiverAddress, valueOr(flat.recipientAddress, defaults.recipientAddress))),
    accountNumber: valueOr(existing?.accountNumber, valueOr(flat.accountNumber, defaults.accountNumber)),
    bankAccount: valueOr(existing?.bankAccount, valueOr(existing?.accountNumber, valueOr(flat.bankAccount, valueOr(flat.accountNumber, defaults.accountNumber)))),
    residentName: valueOr(existing?.residentName, valueOr(flat.displayName, valueOr(flat.name, flat.payerName))),
    residentEmail: valueOr(existing?.residentEmail, valueOr(flat.email, flat.payerEmail)),
    status: "DRAFT",
    isPublished: false,
    updatedAtMs: nowMs(),
    createdAtMs: Number(existing?.createdAtMs || nowMs()),
    runtimeFixVersion: RUNTIME_FIX_VERSION
  }, { merge: true });

  return { settlementId, paymentRef, totalChargesCents, totalPaymentsCents, balanceCents };
}

function normalizeInvoiceScope(scope, assignment = {}, parsed = {}, invoice = {}) {
  const raw = safeString(scope || assignment.scope || parsed.scope || parsed.allocationType || invoice.ai?.suggestion?.scope || invoice.ai?.suggestion?.allocationType).toUpperCase();
  if (["FLAT", "LOCAL", "LOKAL"].includes(raw)) return "FLAT";
  if (["BUILDING", "BUDYNEK"].includes(raw)) return "BUILDING";
  if (["STAIRCASE", "KLATKA", "ENTRANCE"].includes(raw)) return "STAIRCASE";
  if (["COMMUNITY", "WSPOLNOTA"].includes(raw)) return "COMMUNITY";
  if (["COMMON", "WSPOLNE", "CZESCI_WSPOLNE", "CZESCI_WSPOLNE"].includes(raw)) return "COMMON";

  const hintText = [
    assignment.reason,
    parsed.reason,
    parsed.ocrText,
    parsed.extractedText,
    parsed.description,
    parsed.streetName,
    parsed.street,
    parsed.buildingNo,
    parsed.apartmentNo,
    parsed.address,
    invoice.filename,
    invoice.extractedText,
    JSON.stringify(invoice.parsed?.items || []),
  ].map(safeString).filter(Boolean).join("\n");

  return detectInvoiceScope(hintText).scope;
}

async function resolveFlatsForScope(communityId, scope, assignment = {}, parsed = {}) {
  const allFlats = await listFlats(communityId);
  const directStreetId = safeString(assignment.streetId || parsed.streetId || parsed.suggestedStreetId);
  const directBuildingId = safeString(assignment.buildingId || parsed.buildingId || parsed.suggestedBuildingId || parsed.buildingNo);
  const directStaircaseId = safeString(assignment.staircaseId || parsed.staircaseId || assignment.entranceId || parsed.entranceId || parsed.suggestedStaircaseId);
  const directFlatId = safeString(assignment.flatId || parsed.flatId || parsed.suggestedFlatId);
  const hintText = [
    assignment.reason,
    parsed.reason,
    parsed.ocrText,
    parsed.extractedText,
    parsed.streetName,
    parsed.suggestedStreetName,
    parsed.street,
    parsed.buildingNo,
    parsed.apartmentNo,
    parsed.suggestedApartmentNo,
    parsed.address,
    parsed.description,
  ].map(safeString).filter(Boolean).join("\n");
  const hints = parseAddressHints(hintText);

  const normalizedStreetId = normalizeStreetName(directStreetId || "");
  const normalizedStreetName = normalizeLookup(assignment.streetName || parsed.streetName || parsed.suggestedStreetName || parsed.street || hints.streetName);
  const normalizedBuilding = normalizeBuildingNo(directBuildingId || hints.buildingNo);
  const normalizedApartment = normalizeBuildingNo(directFlatId ? "" : (assignment.apartmentNo || parsed.apartmentNo || parsed.suggestedApartmentNo || hints.apartmentNo));
  const normalizedStaircase = normalizeLookup(directStaircaseId || hints.staircaseId);
  const scopeHint = detectInvoiceScope(hintText, scope);
  const directFlat = directFlatId ? allFlats.find((f) => safeString(f.id) === directFlatId) : null;

  const matchesStreet = (flat) => {
    if (!normalizedStreetId && !normalizedStreetName) return true;
    const flatStreetId = normalizeStreetName(flat.streetId || "");
    const flatStreetName = normalizeLookup(flat.street || flat.streetName || "");
    return (!!normalizedStreetId && flatStreetId === normalizedStreetId) || (!!normalizedStreetName && flatStreetName.includes(normalizedStreetName));
  };

  const matchesBuilding = (flat) => {
    if (!normalizedBuilding) return true;
    return normalizeBuildingNo(flat.buildingNo || flat.buildingId || "") === normalizedBuilding;
  };

  const matchesApartment = (flat) => {
    if (!normalizedApartment) return true;
    return normalizeBuildingNo(flat.apartmentNo || flat.flatNumber || "") === normalizedApartment;
  };

  const matchesStaircase = (flat) => {
    if (!normalizedStaircase) return true;
    return normalizeLookup(flat.staircaseId || flat.staircase || flat.entranceId || flat.entrance || flat.klatka) === normalizedStaircase;
  };

  const byAddress = allFlats.filter((flat) => matchesStreet(flat) && matchesBuilding(flat) && matchesApartment(flat));
  const byBuilding = allFlats.filter((flat) => matchesStreet(flat) && matchesBuilding(flat));
  const byStaircase = allFlats.filter((flat) => matchesStreet(flat) && matchesBuilding(flat) && matchesStaircase(flat));
  const byStreet = allFlats.filter((flat) => matchesStreet(flat));

  let flats = [];

  if (scope === "FLAT") {
    if (directFlat) return [directFlat];
    return byAddress.slice(0, 1);
  }

  if (scope === "BUILDING") {
    if (directFlat) {
      return allFlats.filter((flat) => {
        const sameStreet = normalizeLookup(flat.street || flat.streetName || "") === normalizeLookup(directFlat.street || directFlat.streetName || "") || safeString(flat.streetId) === safeString(directFlat.streetId || "");
        const sameBuilding = normalizeBuildingNo(flat.buildingNo || flat.buildingId || "") === normalizeBuildingNo(directFlat.buildingNo || directFlat.buildingId || "");
        return sameStreet && sameBuilding;
      });
    }
    flats = byBuilding.length ? byBuilding : byStreet;
    return Array.from(new Map(flats.map((x) => [x.id, x])).values());
  }

  if (scope === "STAIRCASE") {
    if (directFlat) {
      flats = allFlats.filter((flat) => {
        const sameStreet = normalizeLookup(flat.street || flat.streetName || "") === normalizeLookup(directFlat.street || directFlat.streetName || "") || safeString(flat.streetId) === safeString(directFlat.streetId || "");
        const sameBuilding = normalizeBuildingNo(flat.buildingNo || flat.buildingId || "") === normalizeBuildingNo(directFlat.buildingNo || directFlat.buildingId || "");
        const sameStair = normalizeLookup(flat.staircaseId || flat.staircase || flat.entranceId || flat.entrance || flat.klatka) === normalizeLookup(directFlat.staircaseId || directFlat.staircase || directFlat.entranceId || directFlat.entrance || directFlat.klatka);
        return sameStreet && sameBuilding && sameStair;
      });
    }
    if (!flats.length) flats = byStaircase;
    if (!flats.length && normalizedStaircase) flats = byBuilding.filter(matchesStaircase);
    return Array.from(new Map(flats.map((x) => [x.id, x])).values());
  }

  if (scope === "COMMUNITY") {
    return Array.from(new Map(allFlats.map((x) => [x.id, x])).values());
  }

  if (directFlat) {
    flats = allFlats.filter((flat) => {
      const sameStreet = normalizeLookup(flat.street || flat.streetName || "") === normalizeLookup(directFlat.street || directFlat.streetName || "") || safeString(flat.streetId) === safeString(directFlat.streetId || "");
      const sameBuilding = normalizeBuildingNo(flat.buildingNo || flat.buildingId || "") === normalizeBuildingNo(directFlat.buildingNo || directFlat.buildingId || "");
      const directStair = normalizeLookup(directFlat.staircaseId || directFlat.staircase || directFlat.entranceId || directFlat.entrance || directFlat.klatka);
      return sameStreet && sameBuilding && (!normalizedStaircase || !directStair || matchesStaircase(flat));
    });
  }

  if (!flats.length && normalizedStaircase) flats = byStaircase;
  if (!flats.length && normalizedBuilding) flats = byBuilding;
  if (!flats.length && scopeHint.scope === "COMMUNITY") flats = allFlats;
  if (!flats.length && byStreet.length && (scopeHint.scope === "COMMON" || scopeHint.scope === "BUILDING")) flats = byStreet;
  if (!flats.length && byAddress.length && normalizedApartment && scopeHint.scope !== "FLAT") {
    flats = byBuilding.length ? byBuilding : byStreet;
  }
  if (!flats.length) flats = allFlats;

  return Array.from(new Map(flats.map((x) => [x.id, x])).values());
}

async function replaceInvoiceCharges(communityId, invoiceId, nextCharges) {
  const previous = await db.collection(`communities/${communityId}/charges`).where("invoiceId", "==", invoiceId).get();
  const affected = new Set();
  const batch = db.batch();
  previous.docs.forEach((doc) => {
    affected.add(safeString(doc.data().flatId));
    batch.delete(doc.ref);
  });
  nextCharges.forEach((charge) => {
    const ref = db.collection(`communities/${communityId}/charges`).doc();
    batch.set(ref, charge);
    affected.add(safeString(charge.flatId));
  });
  await batch.commit();
  return Array.from(affected).filter(Boolean);
}

async function recalcAllSettlementsForPeriod(communityId, period) {
  const flats = await listFlats(communityId);
  const out = [];
  for (const flat of flats) {
    out.push(await recalcSettlement(communityId, flat.id, period));
  }
  return out;
}

exports.approveInvoice = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const invoiceId = safeString(request.data?.invoiceId);
  const assignment = request.data?.assignment || {};
  await assertSameCommunity(me, communityId);
  if (!invoiceId) throw new HttpsError("invalid-argument", "Brak invoiceId.");

  let ref = db.doc(`communities/${communityId}/invoices/${invoiceId}`);
  let snap = await ref.get();
  if (!snap.exists) {
    ref = db.doc(`communities/${communityId}/ksefInvoices/${invoiceId}`);
    snap = await ref.get();
  }
  if (!snap.exists) throw new HttpsError("not-found", "Faktura nie istnieje.");

  const inv = snap.data();
  const invoiceStatus = safeString(inv.status).toUpperCase();
  if (invoiceStatus === "PRZENIESIONA_DO_SZKICU" || invoiceStatus === "ARCHIVED") {
    throw new HttpsError("already-exists", "Ta faktura została już wcześniej przeniesiona do szkicu rozliczeń.");
  }
  const parsed = inv.parsed || {};
  const totalCents = Number(parsed.totalGrossCents || parsed.amountCents || inv.totalGrossCents || inv.amountCents || 0);
  const period = safeString(assignment.period || parsed.period || inv.period || inv.ai?.suggestion?.period);
  const category = safeString(assignment.category || parsed.category || inv.category || inv.ai?.suggestion?.category || "INNE");
  const scope = normalizeInvoiceScope(assignment.scope, assignment, parsed, inv);
  const buildingId = safeString(assignment.buildingId || parsed.buildingId || parsed.suggestedBuildingId || inv.ai?.suggestion?.buildingId);
  const streetId = safeString(assignment.streetId || parsed.streetId || parsed.suggestedStreetId || inv.ai?.suggestion?.streetId);
  const staircaseId = safeString(assignment.staircaseId || parsed.staircaseId || parsed.suggestedStaircaseId || inv.ai?.suggestion?.staircaseId);
  const flatId = safeString(assignment.flatId || parsed.flatId || parsed.suggestedFlatId || inv.ai?.suggestion?.flatId);
  const archiveMonth = safeString(period || monthFromDateStr(parsed.issueDate || inv.issueDate));

  if (!period) throw new HttpsError("invalid-argument", "Brak okresu.");
  if (totalCents <= 0) throw new HttpsError("failed-precondition", "Brak kwoty na fakturze.");

  const targetFlats = await resolveFlatsForScope(communityId, scope, {
    scope,
    streetId,
    buildingId,
    staircaseId,
    flatId,
    apartmentNo: assignment.apartmentNo,
    streetName: assignment.streetName,
  }, parsed);

  if (targetFlats.length === 0) {
    throw new HttpsError("failed-precondition", `Brak lokali do naliczenia dla typu kosztu ${scope}. streetId=${streetId || "-"} buildingId=${buildingId || "-"} staircaseId=${staircaseId || "-"} flatId=${flatId || "-"}`);
  }

  const duplicateSignature = normalizeLookup([
    safeString(inv.invoiceNumber || parsed.invoiceNumber),
    safeString(inv.supplierName || inv.vendorName || parsed.sellerName),
    String(totalCents),
    period,
    scope,
  ].join("|"));
  if (duplicateSignature) {
    const existingChargesSnap = await db.collection(`communities/${communityId}/charges`).where("period", "==", period).get();
    const duplicateForFlat = new Set(existingChargesSnap.docs
      .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
      .filter((charge) => normalizeLookup([
        safeString(charge.invoiceNumber),
        safeString(charge.supplierName || charge.vendorName || charge.sellerName),
        String(Number(charge.invoiceTotalCents || charge.totalGrossCents || 0)),
        safeString(charge.period),
        safeString(charge.scope),
      ].join("|")) === duplicateSignature)
      .map((charge) => safeString(charge.flatId))
      .filter(Boolean));
    const duplicatedTarget = targetFlats.find((flat) => duplicateForFlat.has(safeString(flat.id)));
    if (duplicatedTarget) {
      throw new HttpsError("already-exists", `W szkicach istnieje już naliczenie tej faktury dla lokalu ${duplicatedTarget.flatLabel || duplicatedTarget.id}.`);
    }
  }

  const useArea = targetFlats.some((f) => Number(f.areaM2 || 0) > 0) && scope !== "FLAT";
  const totalWeight = useArea
    ? targetFlats.reduce((sum, flat) => sum + Math.max(0, Number(flat.areaM2 || 0)), 0)
    : targetFlats.length;

  const createdCharges = [];
  let allocated = 0;
  for (let i = 0; i < targetFlats.length; i += 1) {
    const flat = targetFlats[i];
    const weight = scope === "FLAT" ? 1 : (useArea ? Math.max(0, Number(flat.areaM2 || 0)) : 1);
    let part = scope === "FLAT" ? totalCents : Math.floor((totalCents * weight) / Math.max(1, totalWeight));
    if (i === targetFlats.length - 1) part = totalCents - allocated;
    allocated += part;

    createdCharges.push({
      createdAtMs: nowMs(),
      updatedAtMs: nowMs(),
      source: inv.source || "OCR",
      invoiceId,
      flatId: flat.id,
      buildingId: flat.buildingId || flat.buildingNo || buildingId || null,
      streetId: flat.streetId || streetId || null,
      staircaseId: flat.staircaseId || flat.staircase || flat.entranceId || staircaseId || null,
      category,
      period,
      amountCents: part,
      currency: "PLN",
      status: "OPEN",
      scope,
      costTarget: scope === "FLAT"
        ? "flat"
        : scope === "BUILDING"
          ? "building"
          : scope === "STAIRCASE"
            ? "staircase"
            : scope === "COMMUNITY"
              ? "community"
              : "buildingCharges",
      allocationMethod: scope === "FLAT" ? "DIRECT" : (useArea ? "AREA" : "EQUAL"),
      invoiceNumber: safeString(inv.invoiceNumber || parsed.invoiceNumber),
      supplierName: safeString(inv.supplierName || inv.vendorName || parsed.sellerName),
      totalGrossCents,
      invoiceTotalCents: totalCents,
      runtimeFixVersion: RUNTIME_FIX_VERSION,
    });
  }

  const affectedFlatIds = await replaceInvoiceCharges(communityId, invoiceId, createdCharges);
  for (const affectedFlatId of affectedFlatIds) {
    await recalcSettlement(communityId, affectedFlatId, period);
  }

  await ref.set({
    status: "PRZENIESIONA_DO_SZKICU",
    approvedAtMs: nowMs(),
    approvedByUid: request.auth.uid,
    archivedAtMs: nowMs(),
    archivedByUid: request.auth.uid,
    archiveMonth: archiveMonth || period,
    isArchived: true,
    movedToDraftAtMs: nowMs(),
    settlementDraftCount: createdCharges.length,
    lastDraftPeriod: period,
    assigned: {
      scope,
      streetId: streetId || null,
      buildingId: buildingId || null,
      staircaseId: staircaseId || null,
      flatId: flatId || null,
      category,
      period,
      affectedFlatIds,
    },
    runtimeFixVersion: RUNTIME_FIX_VERSION,
  }, { merge: true });

  return {
    ok: true,
    chargesCreated: createdCharges.length,
    affectedFlatIds,
    scope,
    archived: true,
    archiveMonth: archiveMonth || period,
    runtimeFixVersion: RUNTIME_FIX_VERSION,
  };
});

exports.rebuildSettlementsForPeriod = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const period = safeString(request.data?.period);
  await assertSameCommunity(me, communityId);
  if (!period) throw new HttpsError("invalid-argument", "Brak period.");

  const out = await recalcAllSettlementsForPeriod(communityId, period);
  return { ok: true, count: out.length };
});

// =========================================================
// PDF / EMAIL / PUBLISH FLOW
// =========================================================

async function buildSettlementPdfBuffer({ communityId, flatId, period, charges, settlement }) {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const chunks = [];
  doc.on("data", d => chunks.push(d));
  const done = new Promise(resolve => doc.on("end", resolve));

  doc.fontSize(16).text("e-Lokator – Rozliczenie", { align: "center" });
  doc.moveDown();
  doc.fontSize(12).text(`Wspólnota: ${communityId}`);
  doc.text(`Lokal: ${settlement?.flatLabel || flatId}`);
  doc.text(`Okres: ${period}`);
  doc.text(`Termin płatności: ${settlement?.dueDate || `${period}-15`}`);
  doc.text(`Rachunek: ${settlement?.accountNumber || ""}`);
  doc.text(`Tytuł przelewu: ${settlement?.paymentTitle || ""}`);
  if (settlement?.transferName) doc.text(`Odbiorca: ${settlement.transferName}`);
  if (settlement?.transferAddress) doc.text(`Adres odbiorcy: ${settlement.transferAddress}`);
  doc.moveDown();

  const totalCharges = charges.reduce((s, c) => s + Number(c.amountCents || 0), 0);
  doc.text(`Suma naliczeń: ${formatMoney(totalCharges)}`);
  doc.text(`Saldo: ${formatMoney(settlement?.balanceCents || totalCharges)}`);
  doc.moveDown();
  doc.text("Pozycje:");
  charges.forEach(c => doc.text(`- ${c.category || "INNE"}: ${formatMoney(Number(c.amountCents || 0))}`));

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

async function sendSettlementEmailInternal({ communityId, flatId, period }) {
  const settlementId = settlementDocId(flatId, period);
  const chosen = await getPreferredSettlement(communityId, settlementId);
  if (!chosen.data) throw new HttpsError("not-found", "Brak rozliczenia.");

  const settlement = chosen.data;
  const email = safeString(settlement.residentEmail || settlement.email);
  if (!email) {
    await db.collection(`communities/${communityId}/mailLogs`).add({
      createdAtMs: nowMs(),
      mode: "SKIPPED",
      reason: "Brak email",
      flatId,
      period
    });
    return { ok: true, mode: "SKIPPED" };
  }

  const chargesSnap = await db.collection(`communities/${communityId}/charges`)
    .where("flatId", "==", flatId)
    .where("period", "==", period)
    .get();
  const charges = chargesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const pdf = await buildSettlementPdfBuffer({ communityId, flatId, period, charges, settlement });

  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const from = process.env.MAIL_FROM || "no-reply@e-lokator.org";

  if (!smtpHost || !smtpUser || !smtpPass) {
    await db.collection(`communities/${communityId}/mailLogs`).add({
      createdAtMs: nowMs(),
      mode: "MOCK",
      to: email,
      subject: `Rozliczenie ${period}`,
      flatId,
      period
    });
    return { ok: true, mode: "MOCK" };
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: smtpUser, pass: smtpPass }
  });

  await transporter.sendMail({
    from,
    to: email,
    subject: `Rozliczenie ${period}`,
    text: `W załączniku rozliczenie za okres ${period}.`,
    attachments: [{ filename: `rozliczenie_${period}.pdf`, content: pdf }]
  });

  return { ok: true, mode: "SMTP" };
}

exports.generateSettlementPdf = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const flatId = safeString(request.data?.flatId);
  const period = safeString(request.data?.period);
  await assertSameCommunity(me, communityId);
  if (!flatId || !period) throw new HttpsError("invalid-argument", "Brak flatId/period.");

  const settlementId = settlementDocId(flatId, period);
  const chosen = await getPreferredSettlement(communityId, settlementId);
  const settlement = chosen.data || null;

  const chargesSnap = await db.collection(`communities/${communityId}/charges`)
    .where("flatId", "==", flatId)
    .where("period", "==", period)
    .get();
  const charges = chargesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const pdf = await buildSettlementPdfBuffer({ communityId, flatId, period, charges, settlement });
  return { ok: true, base64: pdf.toString("base64"), mime: "application/pdf" };
});

exports.sendSettlementEmail = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const flatId = safeString(request.data?.flatId);
  const period = safeString(request.data?.period);
  await assertSameCommunity(me, communityId);
  if (!flatId || !period) throw new HttpsError("invalid-argument", "Brak flatId/period.");
  return await sendSettlementEmailInternal({ communityId, flatId, period });
});

exports.publishSettlement = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const settlementId = safeString(request.data?.settlementId);
  const sendEmail = request.data?.sendEmail === true;
  await assertSameCommunity(me, communityId);
  if (!settlementId) throw new HttpsError("invalid-argument", "Brak settlementId.");

  const state = await getSettlementState(communityId, settlementId);
  const source = state.draft || state.published;
  if (!source) throw new HttpsError("not-found", "Rozliczenie nie istnieje.");

  const patch = {
    ...source,
    status: "PUBLISHED",
    isPublished: true,
    publishedAtMs: nowMs(),
    publishedByUid: request.auth.uid,
    archiveMonth: safeString(source.period || source.archiveMonth),
    updatedAtMs: nowMs(),
    runtimeFixVersion: RUNTIME_FIX_VERSION,
  };
  if (sendEmail) patch.sentAtMs = nowMs();
  await state.publishedRef.set(patch, { merge: true });
  if (state.draftSnap.exists) await state.draftRef.delete();

  if (sendEmail && source.flatId && source.period) {
    await sendSettlementEmailInternal({ communityId, flatId: source.flatId, period: source.period });
  }

  return { ok: true, settlementId, published: true };
});

exports.publishAllDraftSettlements = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const period = safeString(request.data?.period);
  const sendEmail = request.data?.sendEmail === true;
  await assertSameCommunity(me, communityId);

  const allSnap = await db.collection(`communities/${communityId}/${SETTLEMENT_DRAFTS_COLLECTION}`).get();
  const docs = allSnap.docs.filter((doc) => {
    const data = doc.data() || {};
    const samePeriod = !period || safeString(data.period) === period;
    return samePeriod;
  });

  if (!docs.length) return { ok: true, publishedCount: 0, settlementIds: [] };

  const ids = [];
  for (const doc of docs) {
    const s = doc.data();
    const targetRef = db.doc(`communities/${communityId}/${SETTLEMENTS_COLLECTION}/${doc.id}`);
    const patch = {
      ...s,
      status: "PUBLISHED",
      isPublished: true,
      publishedAtMs: nowMs(),
      publishedByUid: request.auth.uid,
      archiveMonth: safeString(s.period || s.archiveMonth),
      updatedAtMs: nowMs(),
      runtimeFixVersion: RUNTIME_FIX_VERSION,
    };
    if (sendEmail) patch.sentAtMs = nowMs();
    await targetRef.set(patch, { merge: true });
    await doc.ref.delete();

    if (sendEmail && s.flatId && s.period) {
      await sendSettlementEmailInternal({ communityId, flatId: s.flatId, period: s.period });
    }
    ids.push(doc.id);
  }

  return { ok: true, publishedCount: ids.length, settlementIds: ids };
});

// =========================================================
// PAYMENTS + AI MATCH FLOW
// =========================================================

exports.aiMatchPayment = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const title = safeString(request.data?.title);
  const amount = Number(request.data?.amount || 0);
  await assertSameCommunity(me, communityId);
  if (!title) throw new HttpsError("invalid-argument", "Brak tytułu.");

  const candidatesRaw = await listSettlementCandidates(communityId, false);

  const candidates = candidatesRaw.slice(0, 200).map(x => {
    return {
      settlementId: x.id,
      flatId: x.flatId || "",
      flatLabel: x.flatLabel || "",
      period: x.period || "",
      totalDueCents: x.totalDueCents || 0,
      paymentTitle: x.paymentTitle || ""
    };
  });

  let result = await aiMatchPayment({ title, amount, candidates });

  if (!result) {
    const lower = title.toLowerCase();
    const match = candidates.find(c =>
      lower.includes(String(c.paymentTitle || "").toLowerCase()) ||
      lower.includes(String(c.flatLabel || "").toLowerCase())
    );

    result = match ? {
      suggestedFlatId: match.flatId,
      suggestedSettlementId: match.settlementId,
      confidence: 0.72,
      needsReview: false,
      reason: "Dopasowanie heurystyczne po tytule"
    } : {
      suggestedFlatId: "",
      suggestedSettlementId: "",
      confidence: 0.2,
      needsReview: true,
      reason: "Brak pewnego dopasowania"
    };
  }

  if (result.needsReview || Number(result.confidence || 0) < 0.85) {
    await createReviewItem(communityId, {
      type: "PAYMENT_MATCH",
      title: "Weryfikacja dopasowania przelewu",
      reason: result.reason || "AI nie ma wysokiej pewności",
      paymentTitle: title,
      amountCents: toCents(amount),
      confidence: Number(result.confidence || 0),
      suggestedFlatId: result.suggestedFlatId || "",
      suggestedSettlementId: result.suggestedSettlementId || ""
    });
  }

  return { ok: true, result };
});

exports.autoMatchImportedPayment = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const paymentId = safeString(request.data?.paymentId);
  await assertSameCommunity(me, communityId);
  if (!paymentId) throw new HttpsError("invalid-argument", "Brak paymentId.");

  const paymentRef = db.doc(`communities/${communityId}/payments/${paymentId}`);
  const paymentSnap = await paymentRef.get();
  if (!paymentSnap.exists) throw new HttpsError("not-found", "Przelew nie istnieje.");

  const payment = paymentSnap.data();
  const title = safeString(payment.title || payment.transferTitle || payment.description);
  const amount = fromCents(payment.amountCents || 0);

  const ai = await exports.aiMatchPayment.run({
    auth: request.auth,
    data: { communityId, title, amount }
  });

  const result = ai.data?.result || ai.result || ai;
  if (result?.suggestedFlatId) {
    const settlementId = safeString(result.suggestedSettlementId);
    await paymentRef.set({
      flatId: result.suggestedFlatId,
      settlementId,
      matchedBy: Number(result.confidence || 0) >= 0.85 ? "AI" : "REVIEW",
      matchedAtMs: nowMs()
    }, { merge: true });

    const period = settlementId.split("_").slice(1).join("_").replace(/_/g, "-");
    if (result.suggestedFlatId && period) {
      try { await recalcSettlement(communityId, result.suggestedFlatId, period); } catch (e) {}
    }
  }

  return { ok: true, result };
});

// =========================================================
// METERS + AI ANOMALY FLOW
// =========================================================

exports.aiMeterAnomaly = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  await assertSameCommunity(me, communityId);

  const currentValue = Number(request.data?.currentValue || 0);
  const prevValue = Number(request.data?.prevValue || 0);
  const meterType = safeString(request.data?.meterType);
  const unit = safeString(request.data?.unit);
  const flatLabel = safeString(request.data?.flatLabel);

  if (currentValue < prevValue) {
    const result = {
      anomaly: true,
      confidence: 0.99,
      needsReview: true,
      reason: "Nowy odczyt jest mniejszy od poprzedniego."
    };
    await createReviewItem(communityId, {
      type: "METER_ANOMALY",
      title: `Podejrzany odczyt licznika ${flatLabel}`,
      reason: result.reason,
      confidence: result.confidence
    });
    return { ok: true, result };
  }

  let result = await aiAnalyzeMeter({ currentValue, prevValue, meterType, unit, flatLabel });
  if (!result) {
    const diff = currentValue - prevValue;
    result = {
      anomaly: diff > Math.max(prevValue * 0.5, 500),
      confidence: diff > Math.max(prevValue * 0.5, 500) ? 0.78 : 0.45,
      needsReview: diff > Math.max(prevValue * 0.5, 500),
      reason: "Reguła progowa"
    };
  }

  if (result.anomaly || result.needsReview || Number(result.confidence || 0) < 0.85) {
    await createReviewItem(communityId, {
      type: "METER_ANOMALY",
      title: `Podejrzany odczyt licznika ${flatLabel}`,
      reason: result.reason || "Wymaga sprawdzenia",
      confidence: Number(result.confidence || 0),
      meterType,
      unit,
      currentValue,
      prevValue
    });
  }

  return { ok: true, result };
});

exports.reviewImportedMeterReading = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const meterId = safeString(request.data?.meterId);
  const readingId = safeString(request.data?.readingId);
  await assertSameCommunity(me, communityId);
  if (!meterId || !readingId) throw new HttpsError("invalid-argument", "Brak meterId/readingId.");

  const meterSnap = await db.doc(`communities/${communityId}/meters/${meterId}`).get();
  const readingSnap = await db.doc(`communities/${communityId}/meterReadings/${readingId}`).get();
  if (!meterSnap.exists || !readingSnap.exists) throw new HttpsError("not-found", "Brak licznika lub odczytu.");

  const meter = meterSnap.data();
  const reading = readingSnap.data();

  const prevSnap = await db.collection(`communities/${communityId}/meterReadings`)
    .where("meterId", "==", meterId)
    .where("date", "<", reading.date)
    .orderBy("date", "desc")
    .limit(1)
    .get();

  const prevValue = prevSnap.empty ? 0 : Number(prevSnap.docs[0].data().value || 0);
  const currentValue = Number(reading.value || 0);

  return await exports.aiMeterAnomaly.run({
    auth: request.auth,
    data: {
      communityId,
      currentValue,
      prevValue,
      meterType: meter.type || "",
      unit: meter.unit || "",
      flatLabel: meter.flatLabel || ""
    }
  });
});

// =========================================================
// REVIEW EXPLAIN
// =========================================================

exports.aiExplainReview = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const reviewId = safeString(request.data?.reviewId);
  await assertSameCommunity(me, communityId);
  if (!reviewId) throw new HttpsError("invalid-argument", "Brak reviewId.");

  const snap = await db.doc(`communities/${communityId}/reviewQueue/${reviewId}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "Review item nie istnieje.");

  const item = snap.data();
  const explanation = await aiExplainReview(item) || {
    summary: "Sprawa wymaga weryfikacji ręcznej.",
    reason: item.reason || "Brak wysokiej pewności systemu.",
    recommendedChecks: ["Sprawdź dane źródłowe", "Porównaj z lokalem i kwotą"]
  };

  await snap.ref.set({
    aiExplanation: explanation,
    aiExplainedAtMs: nowMs()
  }, { merge: true });

  return { ok: true, explanation };
});
