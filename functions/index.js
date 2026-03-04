const admin = require("firebase-admin");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { XMLParser } = require("fast-xml-parser");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");

let OpenAI = null;
try { OpenAI = require("openai").default; } catch (e) { /* optional */ }

setGlobalOptions({ region: "europe-west1" });

try {
  admin.app();
} catch (e) {
  admin.initializeApp();
}

const db = admin.firestore();

// --- ROLE HELPERS ---
async function getMe(uid) {
  if (!uid) return null;
  const snap = await db.doc(`users/${uid}`).get();
  return snap.exists ? snap.data() : null;
}

async function assertSignedIn(request) {
  if (!request.auth || !request.auth.uid) throw new HttpsError("unauthenticated", "Zaloguj się.");
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
  if (!hasRole(me, ["MASTER", "ADMIN", "ACCOUNTANT"])) throw new HttpsError("permission-denied", "Brak uprawnień.");
  return me;
}

async function assertAdminOrMaster(request) {
  const me = await assertSignedIn(request);
  if (!hasRole(me, ["MASTER", "ADMIN"])) throw new HttpsError("permission-denied", "Brak uprawnień.");
  return me;
}

// --- CONFIG / OWNER ---
const OWNER_UIDS = ["C4NPiqCNCChdDZ0s54di5g8Mt5l2"];
const OWNER_EMAILS = ["mrlachnowicz@gmail.com"];

function assertOwner(request) {
  if (!request.auth || !request.auth.uid) throw new HttpsError("unauthenticated", "Zaloguj się.");
  const token = request.auth.token || {};
  const email = String(request.auth.token.email || "");
  const ok = token.owner === true || OWNER_UIDS.includes(request.auth.uid) || OWNER_EMAILS.includes(email);
  if (!ok) throw new HttpsError("permission-denied", "Brak uprawnień Ownera.");
}

function randomCode(len = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return out;
}

// --- FCM HELPERS (Z e-Lokatora) ---

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
  return snap.docs.map(d => d.data().fcmToken).filter(t => !!t);
}

async function sendToToken(token, type, title, body, extraData = {}) {
  if (!token) return;
  const message = { token, data: { type, title, body, ...extraData }, android: { priority: "high" } };
  try { await admin.messaging().send(message); } catch (e) { console.error("FCM Error:", e); }
}

async function sendToTokens(tokens, type, title, body, extraData = {}) {
  if (!tokens || tokens.length === 0) return;
  const message = { tokens, data: { type, title, body, ...extraData } };
  try { await admin.messaging().sendEachForMulticast(message); } catch (e) { console.error("FCM Multicast Error:", e); }
}

async function sendToTopic(topic, type, title, body, extraData = {}) {
  const message = { topic, data: { type, title, body, ...extraData } };
  try { await admin.messaging().send(message); } catch (e) { console.error("FCM Topic Error:", e); }
}

// --- FIRESTORE TRIGGERS ---

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
  await sendToTokens(adminTokens, "ticket_new", "Nowa usterka", `${data.flatLabel}: ${data.title}`, { senderUid: data.createdByUid });
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

// --- CALLABLES (PEŁNA LOGIKA) ---

exports.createActivationCode = onCall(async (request) => {
  assertOwner(request);
  const data = request.data || {};
  const name = String(data.name || data.orgName || "").trim();
  const nip = String(data.nip || "").replace(/\D/g, "");
  if (!name || nip.length !== 10) throw new HttpsError("invalid-argument", "Podaj nazwę i poprawny NIP.");

  for (let i = 0; i < 10; i++) {
    const code = randomCode(10);
    const ref = db.doc(`activation_codes/${code}`);
    try {
      await ref.create({ code, name, nip, used: false, status: "ACTIVE", createdAtMs: Date.now(), createdByUid: request.auth.uid });
      return { code, docPath: ref.path };
    } catch (e) { if (e.code !== 6) throw e; }
  }
  throw new HttpsError("resource-exhausted", "Błąd generowania kodu.");
});

exports.createInvite = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Zaloguj się.");
  const data = request.data || {};
  const meSnap = await db.doc(`users/${request.auth.uid}`).get();
  const me = meSnap.data();
  const invite = {
    customerId: me.customerId || me.communityId,
    communityId: me.communityId,
    role: data.role || "RESIDENT",
    status: "active",
    createdAtMs: Date.now(),
    expiresAtMs: Number(data.expiresAtMs)
  };
  const ref = await db.collection("invites").add(invite);
  return { inviteId: ref.id };
});

exports.claimInvite = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Zaloguj się.");
  const inviteId = request.data.inviteId;
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(db.doc(`invites/${inviteId}`));
    const inv = snap.data();
    tx.set(db.doc(`users/${request.auth.uid}`), { role: inv.role, communityId: inv.communityId, customerId: inv.customerId, updatedAtMs: Date.now() }, { merge: true });
    tx.update(db.doc(`invites/${inviteId}`), { status: "used", usedByUid: request.auth.uid });
    return { ok: true };
  });
});

exports.activateCommunity = onCall(async (request) => {
  const { code, nip, name } = request.data;
  const communityDoc = db.collection("communities").doc();
  return await db.runTransaction(async (tx) => {
    tx.set(communityDoc, { id: communityDoc.id, name, nip, createdAtMs: Date.now(), seatsTotal: 2 });
    tx.set(db.doc(`users/${request.auth.uid}`), { role: "MASTER", communityId: communityDoc.id, customerId: communityDoc.id }, { merge: true });
    tx.update(db.doc(`activation_codes/${code}`), { used: true, communityId: communityDoc.id });
    return { communityId: communityDoc.id };
  });
});

// Pozostałe funkcje (usuwanie, blokowanie itp.)
exports.removeUser = onCall(async (request) => { await db.doc(`users/${request.data.targetUid}`).update({ role: "REMOVED" }); return { ok: true }; });
exports.setUserBlocked = onCall(async (request) => { await db.doc(`users/${request.data.targetUid}`).update({ appBlocked: request.data.blocked }); return { ok: true }; });
exports.addStreet = onCall(async (request) => { /* logika addStreet */ return { ok: true }; });

// =========================================================
// WEBPANEL / KSeF / AI / ROZLICZENIA (MVP)
// =========================================================

function nowMs() { return Date.now(); }

function randomToken(len = 32) {
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

function monthFromDateStr(yyyyMmDd) {
  if (!yyyyMmDd) return "";
  const s = String(yyyyMmDd);
  return s.length >= 7 ? s.slice(0, 7) : s;
}

async function getCommunity(communityId) {
  const snap = await db.doc(`communities/${communityId}`).get();
  return snap.exists ? snap.data() : null;
}

async function ensureCommunityJoinCode(communityId, role) {
  const code = randomCode(10);
  const ref = db.doc(`join_codes/${code}`);
  await ref.create({ code, communityId, role, createdAtMs: nowMs(), status: "ACTIVE" });
  return code;
}

exports.createJoinCode = onCall(async (request) => {
  const me = await assertAdminOrMaster(request);
  const role = String(request.data?.role || "ACCOUNTANT").toUpperCase();
  if (!["ACCOUNTANT", "ADMIN", "RESIDENT"].includes(role)) throw new HttpsError("invalid-argument", "Nieobsługiwana rola.");
  const communityId = String(request.data?.communityId || me.communityId || "");
  if (!communityId) throw new HttpsError("invalid-argument", "Brak communityId.");
  if (communityId !== me.communityId) throw new HttpsError("permission-denied", "Inna wspólnota.");
  const code = await ensureCommunityJoinCode(communityId, role);
  return { code, communityId, role };
});

exports.claimJoinCode = onCall(async (request) => {
  const me = await assertSignedIn(request);
  const code = String(request.data?.code || "").trim();
  if (!code) throw new HttpsError("invalid-argument", "Podaj kod.");
  const ref = db.doc(`join_codes/${code}`);
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Kod nie istnieje.");
    const jc = snap.data();
    if (jc.status !== "ACTIVE") throw new HttpsError("failed-precondition", "Kod nieważny.");
    tx.update(ref, { status: "USED", usedAtMs: nowMs(), usedByUid: request.auth.uid });
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

// --- SSO APP -> WEBPANEL ---
// App: createWebSession() -> { token, expiresAtMs, target }
// Web: /sso?token=... -> API consumes token and returns firebase custom token.

exports.createWebSession = onCall(async (request) => {
  const me = await assertSignedIn(request);
  const target = String(request.data?.target || "/payments");
  const token = randomToken(48);
  const expiresAtMs = nowMs() + 2 * 60 * 1000; // 2 min
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
  // Używane TYLKO przez backend webpanelu (firebase-admin), ale zostawiamy też callable jako fallback.
  const token = String(request.data?.token || "");
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
    return { customToken, uid: s.uid, target: s.target || "/payments" };
  });
});

// --- KSeF CONFIG / FETCH (MOCK) / PARSE ---

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function extractText(obj, path) {
  // path: ["a","b","c"]
  try {
    let cur = obj;
    for (const p of path) {
      if (cur == null) return "";
      cur = cur[p];
    }
    if (cur == null) return "";
    if (typeof cur === "string") return cur;
    if (typeof cur === "number") return String(cur);
    return "";
  } catch (_) {
    return "";
  }
}

function parseInvoiceXmlBasic(xml) {
  // MVP parser: obsłuży większość faktur KSeF w formie XML, ale bez gwarancji 100% zgodności.
  const parsed = xmlParser.parse(xml);
  // Bardzo różne struktury – próbujemy wyciągnąć sensowne pola heurystycznie.
  const json = parsed;
  const raw = JSON.stringify(json);
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
  const communityId = String(request.data?.communityId || me.communityId || "");
  if (!communityId || communityId !== me.communityId) throw new HttpsError("permission-denied", "Inna wspólnota.");
  const cfg = {
    mode: String(request.data?.mode || "MOCK"),
    identifier: String(request.data?.identifier || ""),
    updatedAtMs: nowMs(),
    updatedByUid: request.auth.uid
  };
  // Dane wrażliwe (tokeny) trzymamy tylko w backendzie – w MVP zapisujemy placeholder.
  await db.doc(`communities/${communityId}/ksef/config`).set(cfg, { merge: true });
  return { ok: true };
});

exports.ksefFetchInvoices = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = String(request.data?.communityId || me.communityId || "");
  if (!communityId || communityId !== me.communityId) throw new HttpsError("permission-denied", "Inna wspólnota.");

  // MOCK: generujemy 1-3 faktury przykładowe
  const count = Math.max(1, Math.min(3, Number(request.data?.count || 2)));
  const created = [];
  for (let i = 0; i < count; i++) {
    const ksefNumber = `MOCK-${nowMs()}-${i}`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Invoice>\n  <KSeFNumber>${ksefNumber}</KSeFNumber>\n  <IssueDate>2026-03-01</IssueDate>\n  <Seller><Name>TAURON</Name><NIP>1234567890</NIP></Seller>\n  <Buyer><Name>Wspólnota ${communityId}</Name></Buyer>\n  <Total>1234.56</Total>\n  <Items><Item><Name>Energia elektryczna</Name><Amount>1234.56</Amount></Item></Items>\n</Invoice>`;
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
  const communityId = String(request.data?.communityId || me.communityId || "");
  const invoiceId = String(request.data?.invoiceId || "");
  if (!communityId || communityId !== me.communityId) throw new HttpsError("permission-denied", "Inna wspólnota.");
  if (!invoiceId) throw new HttpsError("invalid-argument", "Brak invoiceId.");
  const ref = db.doc(`communities/${communityId}/ksefInvoices/${invoiceId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Faktura nie istnieje.");
  const inv = snap.data();
  const xml = String(inv.xml || "");
  const parsed = parseInvoiceXmlBasic(xml);
  await ref.set({ parsed, parsedAtMs: nowMs() }, { merge: true });
  return { ok: true, parsed };
});

// --- AI SUGGESTIONS (heurystyka / opcjonalnie OpenAI) ---

function heuristicCategory(text) {
  const t = String(text || "").toLowerCase();
  if (t.includes("woda") || t.includes("ściek") || t.includes("kanal")) return "WODA";
  if (t.includes("gaz")) return "GAZ";
  if (t.includes("energia") || t.includes("prąd") || t.includes("tauron") || t.includes("enea")) return "PRAD";
  if (t.includes("sprząt") || t.includes("czysto")) return "SPRZATANIE";
  if (t.includes("remont") || t.includes("napraw") || t.includes("modern")) return "REMONT";
  return "INNE";
}

async function openAiSuggest({ invoiceText }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !OpenAI) return null;
  const client = new OpenAI({ apiKey: key });
  const prompt = `Jesteś asystentem księgowej wspólnoty mieszkaniowej.\n\nNa podstawie tekstu faktury zaproponuj:\n- category: PRAD/WODA/GAZ/SPRZATANIE/REMONT/INNE\n- scope: COMMON lub FLAT\n- period: YYYY-MM\n- confidence: 0-1\n\nZwróć wyłącznie JSON.\n\nFAKTURA:\n${invoiceText}`;
  const resp = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1
  });
  const content = resp.choices?.[0]?.message?.content || "";
  try { return JSON.parse(content); } catch (_) { return null; }
}

exports.aiSuggestInvoice = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = String(request.data?.communityId || me.communityId || "");
  const invoiceId = String(request.data?.invoiceId || "");
  if (!communityId || communityId !== me.communityId) throw new HttpsError("permission-denied", "Inna wspólnota.");
  if (!invoiceId) throw new HttpsError("invalid-argument", "Brak invoiceId.");

  const ref = db.doc(`communities/${communityId}/ksefInvoices/${invoiceId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Faktura nie istnieje.");
  const inv = snap.data();
  const parsed = inv.parsed || {};
  const invoiceText = `${inv.ksefNumber || ""} ${parsed.sellerName || ""} ${parsed.buyerName || ""} ${JSON.stringify(parsed.items || [])}`;

  let suggestion = await openAiSuggest({ invoiceText });
  if (!suggestion) {
    const category = heuristicCategory(invoiceText);
    suggestion = {
      category,
      scope: "COMMON",
      buildingId: null,
      flatId: null,
      period: parsed.period || "",
      confidence: 0.55
    };
  }

  await ref.set({ ai: { status: "READY", suggestion, suggestedAtMs: nowMs(), by: "AI" } }, { merge: true });
  return { ok: true, suggestion };
});

// --- APPROVE + GENERATE CHARGES (MVP) ---

async function listFlats(communityId, buildingId) {
  let q = db.collection(`communities/${communityId}/flats`);
  if (buildingId) q = q.where("buildingId", "==", buildingId);
  const snap = await q.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

exports.approveInvoice = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = String(request.data?.communityId || me.communityId || "");
  const invoiceId = String(request.data?.invoiceId || "");
  const assignment = request.data?.assignment || {};
  if (!communityId || communityId !== me.communityId) throw new HttpsError("permission-denied", "Inna wspólnota.");
  if (!invoiceId) throw new HttpsError("invalid-argument", "Brak invoiceId.");

  const ref = db.doc(`communities/${communityId}/ksefInvoices/${invoiceId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Faktura nie istnieje.");
  const inv = snap.data();
  const parsed = inv.parsed || {};
  const totalCents = Number(parsed.totalGrossCents || 0);
  const period = String(assignment.period || parsed.period || "");
  const category = String(assignment.category || inv.ai?.suggestion?.category || "INNE");
  const scope = String(assignment.scope || inv.ai?.suggestion?.scope || "COMMON");
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

  // Generuj charges
  if (scope === "FLAT" && flatId) {
    const cRef = await db.collection(`communities/${communityId}/charges`).add({
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
    return { ok: true, chargesCreated: 1, chargeIds: [cRef.id] };
  }

  // COMMON: rozbij na lokale
  const flats = await listFlats(communityId, buildingId);
  if (flats.length === 0) throw new HttpsError("failed-precondition", "Brak lokali do rozbicia.");

  const useArea = flats.some(f => Number(f.areaM2 || 0) > 0);
  const totalWeight = useArea ? flats.reduce((s, f) => s + Math.max(0, Number(f.areaM2 || 0)), 0) : flats.length;
  const chargeIds = [];
  let allocated = 0;
  for (let i = 0; i < flats.length; i++) {
    const f = flats[i];
    const w = useArea ? Math.max(0, Number(f.areaM2 || 0)) : 1;
    let part = Math.floor((totalCents * w) / totalWeight);
    if (i === flats.length - 1) part = totalCents - allocated; // domknięcie
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
  }
  return { ok: true, chargesCreated: chargeIds.length, chargeIds };
});

// --- PDF + EMAIL (MOCK) ---

function formatMoney(cents) {
  const z = Math.floor(cents / 100);
  const g = Math.abs(cents % 100).toString().padStart(2, "0");
  return `${z},${g} PLN`;
}

async function buildSettlementPdfBuffer({ communityId, flatId, period, charges }) {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const chunks = [];
  doc.on("data", (d) => chunks.push(d));
  const done = new Promise((resolve) => doc.on("end", resolve));

  doc.fontSize(16).text("e-Lokator – Rozliczenie", { align: "center" });
  doc.moveDown();
  doc.fontSize(12).text(`Wspólnota: ${communityId}`);
  doc.text(`Lokal: ${flatId}`);
  doc.text(`Okres: ${period}`);
  doc.moveDown();

  let sum = 0;
  charges.forEach((c) => { sum += Number(c.amountCents || 0); });
  doc.fontSize(12).text(`Suma naliczeń: ${formatMoney(sum)}`);
  doc.moveDown();
  doc.fontSize(11).text("Pozycje:");
  charges.forEach((c) => {
    doc.text(`- ${c.category || "INNE"}: ${formatMoney(Number(c.amountCents || 0))}`);
  });

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

exports.generateSettlementPdf = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = String(request.data?.communityId || me.communityId || "");
  const flatId = String(request.data?.flatId || "");
  const period = String(request.data?.period || "");
  if (!communityId || communityId !== me.communityId) throw new HttpsError("permission-denied", "Inna wspólnota.");
  if (!flatId || !period) throw new HttpsError("invalid-argument", "Brak flatId/period.");
  const chargesSnap = await db.collection(`communities/${communityId}/charges`).where("flatId", "==", flatId).where("period", "==", period).get();
  const charges = chargesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const pdf = await buildSettlementPdfBuffer({ communityId, flatId, period, charges });
  // Zwracamy base64 (MVP). Produkcyjnie: wrzuć do Storage i zwróć signed URL.
  return { ok: true, base64: pdf.toString("base64"), mime: "application/pdf" };
});

exports.sendSettlementEmail = onCall(async (request) => {
  const me = await assertStaff(request);
  const communityId = String(request.data?.communityId || me.communityId || "");
  const flatId = String(request.data?.flatId || "");
  const period = String(request.data?.period || "");
  if (!communityId || communityId !== me.communityId) throw new HttpsError("permission-denied", "Inna wspólnota.");
  if (!flatId || !period) throw new HttpsError("invalid-argument", "Brak flatId/period.");

  const flatSnap = await db.doc(`communities/${communityId}/flats/${flatId}`).get();
  if (!flatSnap.exists) throw new HttpsError("not-found", "Brak lokalu.");
  const flat = flatSnap.data();
  const email = String(flat.email || flat.payerEmail || "");
  if (!email) throw new HttpsError("failed-precondition", "Brak email dla lokalu.");

  const chargesSnap = await db.collection(`communities/${communityId}/charges`).where("flatId", "==", flatId).where("period", "==", period).get();
  const charges = chargesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const pdf = await buildSettlementPdfBuffer({ communityId, flatId, period, charges });

  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const from = process.env.MAIL_FROM || "no-reply@e-lokator.org";
  if (!smtpHost || !smtpUser || !smtpPass) {
    // MOCK
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

  const transporter = nodemailer.createTransport({ host: smtpHost, port: Number(process.env.SMTP_PORT || 587), secure: false, auth: { user: smtpUser, pass: smtpPass } });
  await transporter.sendMail({
    from,
    to: email,
    subject: `Rozliczenie ${period}`,
    text: `W załączniku rozliczenie za okres ${period}.`,
    attachments: [{ filename: `rozliczenie_${period}.pdf`, content: pdf }]
  });
  return { ok: true, mode: "SMTP" };
});