const admin = require("firebase-admin");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { XMLParser } = require("fast-xml-parser");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");

let OpenAI = null;
try {
  OpenAI = require("openai").default;
} catch (e) {
  /* optional */
}

setGlobalOptions({ region: "europe-west1" });

try {
  admin.app();
} catch (e) {
  admin.initializeApp();
}

const db = admin.firestore();

// =========================================================
// HELPERS
// =========================================================

function nowMs() {
  return Date.now();
}

function randomCode(len = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return out;
}

function randomToken(len = 32) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return out;
}

function normalizeStreetName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
  if (!yyyyMmDd) return "";
  const s = String(yyyyMmDd);
  return s.length >= 7 ? s.slice(0, 7) : s;
}

function formatMoney(cents) {
  const val = Number(cents || 0);
  const sign = val < 0 ? "-" : "";
  const abs = Math.abs(val);
  const z = Math.floor(abs / 100);
  const g = String(abs % 100).padStart(2, "0");
  return `${sign}${z},${g} PLN`;
}

function safeString(v) {
  return String(v || "").trim();
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

const OWNER_UIDS = ["C4NPiqCNCChdDZ0s54di5g8Mt5l2"];
const OWNER_EMAILS = ["mrlachnowicz@gmail.com"];

function assertOwner(request) {
  if (!request.auth || !request.auth.uid) throw new HttpsError("unauthenticated", "Zaloguj się.");
  const token = request.auth.token || {};
  const email = String(request.auth.token.email || "");
  const ok = token.owner === true || OWNER_UIDS.includes(request.auth.uid) || OWNER_EMAILS.includes(email);
  if (!ok) throw new HttpsError("permission-denied", "Brak uprawnień Ownera.");
}

async function getCommunity(communityId) {
  const snap = await db.doc(`communities/${communityId}`).get();
  return snap.exists ? snap.data() : null;
}

async function assertSameCommunity(me, communityId) {
  if (!communityId || communityId !== me.communityId) {
    throw new HttpsError("permission-denied", "Inna wspólnota.");
  }
}

function ensureOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !OpenAI) return null;
  return new OpenAI({ apiKey: key });
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

async function getFlatResidents(communityId, flatId) {
  const snap = await db.collection("users")
    .where("communityId", "==", communityId)
    .where("flatId", "==", flatId)
    .where("role", "==", "RESIDENT")
    .get();
  return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
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

exports.onVoteCreated = onDocumentCreated("communities/{communityId}/votes/{voteId}", async (event) => {
  const data = event.data.data();
  await sendToTopic(`community_${event.params.communityId}`, "vote_new", "Nowe głosowanie", data.title, { senderUid: data.createdByUid });
});

// Powiadom dopiero, gdy settlement zostanie opublikowany.
exports.onSettlementPublished = onDocumentUpdated("communities/{communityId}/settlements/{settlementId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const wasPublished = before?.isPublished === true;
  const isPublished = after?.isPublished === true;

  if (wasPublished || !isPublished) return;

  const communityId = event.params.communityId;
  const residents = await getFlatResidents(communityId, after.flatId);
  const tokens = residents.map(r => r.fcmToken).filter(Boolean);

  if (tokens.length > 0) {
    await sendToTokens(
      tokens,
      "settlement_ready",
      "Nowe rozliczenie",
      `${after.period || ""} • ${after.flatLabel || after.flatId || ""}`,
      {
        settlementId: event.params.settlementId,
        flatId: after.flatId || "",
        period: after.period || ""
      }
    );
  }
});

// =========================================================
// BASIC CALLABLES
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

exports.createInvite = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Zaloguj się.");
  const data = request.data || {};
  const meSnap = await db.doc(`users/${request.auth.uid}`).get();
  const me = meSnap.data() || {};

  const invite = {
    customerId: me.customerId || me.communityId,
    communityId: me.communityId,
    role: data.role || "RESIDENT",
    status: "active",
    createdAtMs: Date.now(),
    expiresAtMs: Number(data.expiresAtMs || 0)
  };
  const ref = await db.collection("invites").add(invite);
  return { inviteId: ref.id };
});

exports.claimInvite = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Zaloguj się.");
  const inviteId = safeString(request.data?.inviteId);

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(db.doc(`invites/${inviteId}`));
    if (!snap.exists) throw new HttpsError("not-found", "Invite nie istnieje.");
    const inv = snap.data();
    tx.set(db.doc(`users/${request.auth.uid}`), {
      role: inv.role,
      communityId: inv.communityId,
      customerId: inv.customerId,
      updatedAtMs: Date.now()
    }, { merge: true });
    tx.update(db.doc(`invites/${inviteId}`), {
      status: "used",
      usedByUid: request.auth.uid
    });
    return { ok: true };
  });
});

exports.activateCommunity = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Zaloguj się.");
  }
  const { code, nip, name } = request.data || {};
  if (!safeString(code) || !safeString(nip) || !safeString(name)) {
    throw new HttpsError("invalid-argument", "Brak danych aktywacji.");
  }

  const communityDoc = db.collection("communities").doc();

  return await db.runTransaction(async (tx) => {
    const codeRef = db.doc(`activation_codes/${code}`);
    const codeSnap = await tx.get(codeRef);
    if (!codeSnap.exists) throw new HttpsError("not-found", "Kod nie istnieje.");
    const codeData = codeSnap.data();
    if (codeData.used === true) throw new HttpsError("failed-precondition", "Kod już użyty.");

    tx.set(communityDoc, {
      id: communityDoc.id,
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
      communityId: communityDoc.id,
      customerId: communityDoc.id,
      updatedAtMs: nowMs()
    }, { merge: true });

    tx.update(codeRef, {
      used: true,
      usedAtMs: nowMs(),
      communityId: communityDoc.id
    });

    return { communityId: communityDoc.id };
  });
});

// =========================================================
// USER / STREET MANAGEMENT
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
  if (!communityId || !name) throw new HttpsError("invalid-argument", "Brak communityId lub nazwy ulicy.");
  await assertSameCommunity(me, communityId);

  const slug = normalizeStreetName(name);
  if (!slug) throw new HttpsError("invalid-argument", "Nieprawidłowa nazwa ulicy.");

  const ref = db.doc(`communities/${communityId}/streets/${slug}`);
  await ref.set({
    id: slug,
    name,
    normalizedName: slug,
    communityId,
    isActive: true,
    updatedAtMs: nowMs(),
    createdAtMs: nowMs(),
    createdByUid: request.auth.uid
  }, { merge: true });

  return { ok: true, streetId: slug, name };
});

// =========================================================
// JOIN CODES / SSO
// =========================================================

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
  if (!communityId) throw new HttpsError("invalid-argument", "Brak communityId.");
  await assertSameCommunity(me, communityId);

  const code = await ensureCommunityJoinCode(communityId, role);
  return { code, communityId, role };
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
  const target = safeString(request.data?.target || "/payments");
  const token = randomToken(48);
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

  return { token, expiresAtMs, target };
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

    tx.update(ref, {
      used: true,
      usedAtMs: nowMs()
    });

    const customToken = await admin.auth().createCustomToken(String(s.uid));
    return { customToken, uid: s.uid, target: s.target || "/payments" };
  });
});

// =========================================================
// KSeF / PARSE
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

exports.ksefSetConfig = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  await assertSameCommunity(me, communityId);

  const cfg = {
    mode: safeString(request.data?.mode || "MOCK"),
    identifier: safeString(request.data?.identifier),
    updatedAtMs: nowMs(),
    updatedByUid: request.auth.uid
  };

  await db.doc(`communities/${communityId}/ksef/config`).set(cfg, { merge: true });
  return { ok: true };
});

exports.ksefFetchInvoices = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  await assertSameCommunity(me, communityId);

  const count = Math.max(1, Math.min(5, Number(request.data?.count || 2)));
  const created = [];

  for (let i = 0; i < count; i++) {
    const ksefNumber = `MOCK-${nowMs()}-${i}`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice>
  <KSeFNumber>${ksefNumber}</KSeFNumber>
  <IssueDate>2026-03-01</IssueDate>
  <Seller><Name>TAURON</Name><NIP>1234567890</NIP></Seller>
  <Buyer><Name>Wspólnota ${communityId}</Name></Buyer>
  <Total>1234.56</Total>
  <Items><Item><Name>Energia elektryczna</Name><Amount>1234.56</Amount></Item></Items>
</Invoice>`;

    const basic = parseInvoiceXmlBasic(xml);
    const ref = await db.collection(`communities/${communityId}/ksefInvoices`).add({
      createdAtMs: nowMs(),
      status: "NOWA",
      source: "MOCK",
      xml,
      parsed: basic,
      ksefNumber,
      assigned: { scope: null },
      ai: { status: "PENDING" }
    });
    created.push({ id: ref.id, ksefNumber });
  }

  return { ok: true, created };
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

  const inv = snap.data();
  const xml = safeString(inv.xml);
  const parsed = parseInvoiceXmlBasic(xml);

  await ref.set({
    parsed,
    parsedAtMs: nowMs()
  }, { merge: true });

  return { ok: true, parsed };
});

// =========================================================
// AI HELPERS
// =========================================================

function heuristicCategory(text) {
  const t = String(text || "").toLowerCase();
  if (t.includes("woda") || t.includes("ściek") || t.includes("kanal")) return "WODA";
  if (t.includes("gaz")) return "GAZ";
  if (t.includes("energia") || t.includes("prąd") || t.includes("tauron") || t.includes("enea")) return "PRAD";
  if (t.includes("sprząt") || t.includes("czysto")) return "SPRZATANIE";
  if (t.includes("remont") || t.includes("napraw") || t.includes("modern")) return "REMONT";
  return "INNE";
}

async function openAiJson(prompt, fallback = null) {
  const client = ensureOpenAI();
  if (!client) return fallback;

  try {
    const resp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL_FAST || "gpt-4o-mini",
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

async function openAiSuggestInvoice({ invoiceText }) {
  const prompt = [
    "Jesteś asystentem księgowej wspólnoty mieszkaniowej.",
    "Na podstawie tekstu faktury zaproponuj JSON:",
    "{",
    '  "category":"PRAD|WODA|GAZ|SPRZATANIE|REMONT|INNE",',
    '  "scope":"COMMON|FLAT",',
    '  "period":"YYYY-MM",',
    '  "confidence":0.0,',
    '  "reason":"krótkie uzasadnienie"',
    "}",
    "",
    "FAKTURA:",
    invoiceText
  ].join("\n");

  return await openAiJson(prompt, null);
}

async function openAiMatchPayment({ title, amount, candidates }) {
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

  return await openAiJson(prompt, null);
}

async function openAiMeterAnomaly({ currentValue, prevValue, meterType, unit, flatLabel }) {
  const prompt = [
    "Oceń, czy odczyt licznika wygląda podejrzanie.",
    "Zwróć wyłącznie JSON:",
    "{",
    '  "anomaly":true,',
    '  "confidence":0.0,',
    '  "reason":"..."',
    "}",
    "",
    `Typ: ${meterType}`,
    `Jednostka: ${unit}`,
    `Lokal: ${flatLabel}`,
    `Poprzedni odczyt: ${prevValue}`,
    `Nowy odczyt: ${currentValue}`
  ].join("\n");

  return await openAiJson(prompt, null);
}

// =========================================================
// AI CALLABLES
// =========================================================

exports.aiSuggestInvoice = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const invoiceId = safeString(request.data?.invoiceId);
  await assertSameCommunity(me, communityId);
  if (!invoiceId) throw new HttpsError("invalid-argument", "Brak invoiceId.");

  const ref = db.doc(`communities/${communityId}/ksefInvoices/${invoiceId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Faktura nie istnieje.");

  const inv = snap.data();
  const parsed = inv.parsed || {};
  const invoiceText = `${inv.ksefNumber || ""} ${parsed.sellerName || ""} ${parsed.buyerName || ""} ${JSON.stringify(parsed.items || [])}`;

  let suggestion = await openAiSuggestInvoice({ invoiceText });
  if (!suggestion) {
    const category = heuristicCategory(invoiceText);
    suggestion = {
      category,
      scope: "COMMON",
      period: parsed.period || "",
      confidence: 0.55,
      reason: "Heurystyka słownikowa"
    };
  }

  await ref.set({
    ai: {
      status: "READY",
      suggestion,
      suggestedAtMs: nowMs(),
      by: "AI"
    }
  }, { merge: true });

  return { ok: true, suggestion };
});

exports.aiMatchPayment = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const title = safeString(request.data?.title);
  const amount = Number(request.data?.amount || 0);
  await assertSameCommunity(me, communityId);
  if (!title) throw new HttpsError("invalid-argument", "Brak tytułu.");

  const settlementsSnap = await db.collection(`communities/${communityId}/settlements`)
    .where("isPublished", "==", true)
    .limit(50)
    .get();

  const candidates = settlementsSnap.docs.map(d => {
    const x = d.data();
    return {
      settlementId: d.id,
      flatId: x.flatId || "",
      flatLabel: x.flatLabel || "",
      period: x.period || "",
      totalDueCents: x.totalDueCents || 0,
      paymentTitle: x.paymentTitle || ""
    };
  });

  let result = await openAiMatchPayment({ title, amount, candidates });

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

  return { ok: true, result };
});

exports.aiMeterAnomaly = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  await assertSameCommunity(me, communityId);

  const currentValue = Number(request.data?.currentValue || 0);
  const prevValue = Number(request.data?.prevValue || 0);
  const meterType = safeString(request.data?.meterType);
  const unit = safeString(request.data?.unit);
  const flatLabel = safeString(request.data?.flatLabel);

  const diff = currentValue - prevValue;
  if (diff < 0) {
    return {
      ok: true,
      result: {
        anomaly: true,
        confidence: 0.99,
        reason: "Nowy odczyt jest mniejszy od poprzedniego."
      }
    };
  }

  let result = await openAiMeterAnomaly({ currentValue, prevValue, meterType, unit, flatLabel });
  if (!result) {
    result = {
      anomaly: diff > Math.max(prevValue * 0.5, 500),
      confidence: diff > Math.max(prevValue * 0.5, 500) ? 0.78 : 0.45,
      reason: "Reguła progowa"
    };
  }

  return { ok: true, result };
});

// =========================================================
// CHARGES / SETTLEMENTS
// =========================================================

async function listFlats(communityId, buildingId = null) {
  let q = db.collection(`communities/${communityId}/flats`);
  if (buildingId) q = q.where("buildingId", "==", buildingId);
  const snap = await q.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getFlat(communityId, flatId) {
  const snap = await db.doc(`communities/${communityId}/flats/${flatId}`).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

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

  const titleCode = safeString(flat.paymentCode || flat.flatLabel || flatId)
    .replace(/\s+/g, "-")
    .toUpperCase();

  const community = await getCommunity(communityId);
  const paymentTitle = `EL-${titleCode} ${period}`;

  const settlementDocId = `${flatId}_${period}`.replace(/[^\w\-]/g, "_");
  const ref = db.doc(`communities/${communityId}/settlements/${settlementDocId}`);

  const transferName = safeString(flat.recipientName || community?.recipientName || community?.name);
  const transferAddress = safeString(flat.recipientAddress || community?.recipientAddress || "");
  const accountNumber = safeString(flat.accountNumber || community?.defaultAccountNumber || community?.accountNumber || "");

  await ref.set({
    id: settlementDocId,
    communityId,
    flatId,
    flatLabel: safeString(flat.flatLabel || `${flat.street || ""} ${flat.buildingNo || ""}/${flat.apartmentNo || ""}`.trim()),
    street: flat.street || "",
    buildingNo: flat.buildingNo || "",
    apartmentNo: flat.apartmentNo || "",
    period,
    totalChargesCents,
    totalPaymentsCents,
    balanceCents,
    totalDueCents: balanceCents,
    dueDate: `${period}-15`,
    paymentTitle,
    transferName,
    transferAddress,
    accountNumber,
    residentName: safeString(flat.name || flat.payerName || ""),
    residentEmail: safeString(flat.email || flat.payerEmail || ""),
    status: "DRAFT",
    isPublished: false,
    updatedAtMs: nowMs(),
    createdAtMs: nowMs()
  }, { merge: true });

  return {
    settlementId: settlementDocId,
    totalChargesCents,
    totalPaymentsCents,
    balanceCents
  };
}

async function recalcAllSettlementsForPeriod(communityId, period) {
  const flats = await listFlats(communityId);
  const out = [];
  for (const flat of flats) {
    const res = await recalcSettlement(communityId, flat.id, period);
    out.push(res);
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

  const ref = db.doc(`communities/${communityId}/ksefInvoices/${invoiceId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Faktura nie istnieje.");

  const inv = snap.data();
  const parsed = inv.parsed || {};
  const totalCents = Number(parsed.totalGrossCents || 0);
  const period = safeString(assignment.period || parsed.period);
  const category = safeString(assignment.category || inv.ai?.suggestion?.category || "INNE");
  const scope = safeString(assignment.scope || inv.ai?.suggestion?.scope || "COMMON");
  const buildingId = assignment.buildingId || null;
  const flatId = assignment.flatId || null;

  if (!period) throw new HttpsError("invalid-argument", "Brak okresu.");
  if (totalCents <= 0) throw new HttpsError("failed-precondition", "Brak kwoty na fakturze.");

  await ref.set({
    status: "ZATWIERDZONA",
    approvedAtMs: nowMs(),
    approvedByUid: request.auth.uid,
    assigned: { scope, buildingId, flatId, category, period }
  }, { merge: true });

  if (scope === "FLAT" && flatId) {
    await db.collection(`communities/${communityId}/charges`).add({
      createdAtMs: nowMs(),
      source: "KSEF",
      invoiceId,
      flatId,
      buildingId: buildingId || null,
      category,
      period,
      amountCents: totalCents,
      currency: "PLN",
      status: "OPEN"
    });

    const settlement = await recalcSettlement(communityId, flatId, period);
    return { ok: true, chargesCreated: 1, settlement };
  }

  const flats = await listFlats(communityId, buildingId);
  if (flats.length === 0) throw new HttpsError("failed-precondition", "Brak lokali do rozbicia.");

  const useArea = flats.some(f => Number(f.areaM2 || 0) > 0);
  const totalWeight = useArea
    ? flats.reduce((s, f) => s + Math.max(0, Number(f.areaM2 || 0)), 0)
    : flats.length;

  let allocated = 0;
  const chargeIds = [];

  for (let i = 0; i < flats.length; i++) {
    const f = flats[i];
    const w = useArea ? Math.max(0, Number(f.areaM2 || 0)) : 1;
    let part = Math.floor((totalCents * w) / totalWeight);
    if (i === flats.length - 1) part = totalCents - allocated;
    allocated += part;

    const cRef = await db.collection(`communities/${communityId}/charges`).add({
      createdAtMs: nowMs(),
      source: "KSEF",
      invoiceId,
      flatId: f.id,
      buildingId: f.buildingId || null,
      category,
      period,
      amountCents: part,
      currency: "PLN",
      status: "OPEN"
    });

    chargeIds.push(cRef.id);
    await recalcSettlement(communityId, f.id, period);
  }

  return { ok: true, chargesCreated: chargeIds.length, chargeIds };
});

// =========================================================
// PDF / EMAIL
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

  let sum = 0;
  charges.forEach(c => { sum += Number(c.amountCents || 0); });

  doc.text(`Suma naliczeń: ${formatMoney(sum)}`);
  doc.text(`Saldo: ${formatMoney(settlement?.balanceCents || sum)}`);
  doc.moveDown();
  doc.text("Pozycje:");
  charges.forEach(c => {
    doc.text(`- ${c.category || "INNE"}: ${formatMoney(Number(c.amountCents || 0))}`);
  });

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

exports.generateSettlementPdf = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const flatId = safeString(request.data?.flatId);
  const period = safeString(request.data?.period);
  await assertSameCommunity(me, communityId);
  if (!flatId || !period) throw new HttpsError("invalid-argument", "Brak flatId/period.");

  const chargesSnap = await db.collection(`communities/${communityId}/charges`)
    .where("flatId", "==", flatId)
    .where("period", "==", period)
    .get();

  const charges = chargesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const settlementId = `${flatId}_${period}`.replace(/[^\w\-]/g, "_");
  const settlementSnap = await db.doc(`communities/${communityId}/settlements/${settlementId}`).get();
  const settlement = settlementSnap.exists ? settlementSnap.data() : null;

  const pdf = await buildSettlementPdfBuffer({ communityId, flatId, period, charges, settlement });
  return { ok: true, base64: pdf.toString("base64"), mime: "application/pdf" };
});

async function sendSettlementEmailInternal({ communityId, flatId, period }) {
  const settlementId = `${flatId}_${period}`.replace(/[^\w\-]/g, "_");
  const settlementSnap = await db.doc(`communities/${communityId}/settlements/${settlementId}`).get();
  if (!settlementSnap.exists) throw new HttpsError("not-found", "Brak rozliczenia.");

  const settlement = settlementSnap.data();
  const email = safeString(settlement.residentEmail);
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

exports.sendSettlementEmail = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const flatId = safeString(request.data?.flatId);
  const period = safeString(request.data?.period);
  await assertSameCommunity(me, communityId);
  if (!flatId || !period) throw new HttpsError("invalid-argument", "Brak flatId/period.");

  return await sendSettlementEmailInternal({ communityId, flatId, period });
});

// =========================================================
// PUBLISH FLOW
// =========================================================

exports.publishSettlement = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const settlementId = safeString(request.data?.settlementId);
  const sendEmail = request.data?.sendEmail === true;
  await assertSameCommunity(me, communityId);
  if (!settlementId) throw new HttpsError("invalid-argument", "Brak settlementId.");

  const ref = db.doc(`communities/${communityId}/settlements/${settlementId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Rozliczenie nie istnieje.");

  const settlement = snap.data();

  await ref.set({
    status: "PUBLISHED",
    isPublished: true,
    publishedAtMs: nowMs(),
    publishedByUid: request.auth.uid,
    sentAtMs: nowMs()
  }, { merge: true });

  if (sendEmail && settlement.flatId && settlement.period) {
    await sendSettlementEmailInternal({
      communityId,
      flatId: settlement.flatId,
      period: settlement.period
    });
  }

  return { ok: true, settlementId, published: true };
});

exports.publishAllDraftSettlements = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const period = safeString(request.data?.period);
  const sendEmail = request.data?.sendEmail === true;
  await assertSameCommunity(me, communityId);
  if (!period) throw new HttpsError("invalid-argument", "Brak period.");

  const snap = await db.collection(`communities/${communityId}/settlements`)
    .where("period", "==", period)
    .where("isPublished", "==", false)
    .get();

  const ids = [];
  for (const doc of snap.docs) {
    const s = doc.data();
    await doc.ref.set({
      status: "PUBLISHED",
      isPublished: true,
      publishedAtMs: nowMs(),
      publishedByUid: request.auth.uid,
      sentAtMs: nowMs()
    }, { merge: true });

    if (sendEmail && s.flatId && s.period) {
      await sendSettlementEmailInternal({
        communityId,
        flatId: s.flatId,
        period: s.period
      });
    }
    ids.push(doc.id);
  }

  return { ok: true, publishedCount: ids.length, settlementIds: ids };
});

// =========================================================
// OPTIONAL: RECALC / REVIEW HELPERS
// =========================================================

exports.rebuildSettlementsForPeriod = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  const period = safeString(request.data?.period);
  await assertSameCommunity(me, communityId);
  if (!period) throw new HttpsError("invalid-argument", "Brak period.");

  const out = await recalcAllSettlementsForPeriod(communityId, period);
  return { ok: true, count: out.length };
});

exports.createMeterReviewItem = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = safeString(request.data?.communityId || me.communityId);
  await assertSameCommunity(me, communityId);

  const payload = {
    type: "METER_ANOMALY",
    communityId,
    meterId: safeString(request.data?.meterId),
    flatId: safeString(request.data?.flatId),
    period: safeString(request.data?.period),
    title: safeString(request.data?.title || "Podejrzany odczyt licznika"),
    reason: safeString(request.data?.reason),
    status: "OPEN",
    createdAtMs: nowMs(),
    createdByUid: request.auth.uid
  };

  const ref = await db.collection(`communities/${communityId}/reviewQueue`).add(payload);
  return { ok: true, reviewId: ref.id };
});
