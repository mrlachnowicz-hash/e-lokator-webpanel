"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { collection, deleteDoc, doc, getDocs, onSnapshot, setDoc, updateDoc, writeBatch } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { auth, db } from "../../lib/firebase";
import { buildStablePaymentTitle, normalizeAccountNumber, normalizePaymentRef } from "../../lib/paymentRefs";
import { mergeSettlementsForView, SETTLEMENTS_COLLECTION, SETTLEMENT_DRAFTS_COLLECTION } from "../../lib/settlementCollections";

type Settlement = any;
type Flat = any;
type PaymentDefaults = { defaultAccountNumber: string; recipientName: string; recipientAddress: string };

function money(v: any) { return `${Number(v || 0).toFixed(2)} PLN`; }
function centsOrAmount(cents: any, amount: any) { return cents != null ? Number(cents) / 100 : Number(amount || 0); }
function monthLabel(period: string) {
  const names = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];
  const m = String(period || "").match(/^(\d{4})-(\d{2})/);
  if (!m) return period || "bez daty";
  return `${names[Number(m[2]) - 1] || m[2]} ${m[1]}`;
}
function readCommunityDefaults(data: any): PaymentDefaults {
  return {
    defaultAccountNumber: String(data?.defaultAccountNumber || data?.accountNumber || data?.bankAccount || data?.paymentSettings?.accountNumber || data?.paymentDefaults?.accountNumber || ""),
    recipientName: String(data?.recipientName || data?.receiverName || data?.transferName || data?.paymentSettings?.recipientName || data?.paymentDefaults?.recipientName || ""),
    recipientAddress: String(data?.recipientAddress || data?.receiverAddress || data?.transferAddress || data?.paymentSettings?.recipientAddress || data?.paymentDefaults?.recipientAddress || ""),
  };
}
function normalizeText(value: any) { return String(value || "").trim(); }
function buildTransferTitle(flat: any, settlement: any) {
  return buildStablePaymentTitle({
    communityId: settlement?.communityId || flat?.communityId || "",
    flatId: flat?.id || settlement?.flatId || "",
    street: flat?.street || settlement?.street || "",
    buildingNo: flat?.buildingNo || settlement?.buildingNo || "",
    apartmentNo: flat?.apartmentNo || settlement?.apartmentNo || "",
    flatLabel: flat?.flatLabel || settlement?.flatLabel || "",
    period: settlement?.period || new Date().toISOString().slice(0, 7),
  });
}
function validAccountNumber(value: any) { const digits = normalizeAccountNumber(value); return digits.length >= 10 && !/^0+$/.test(digits); }
function pickSettlementTitle(settlement: any, flat: any) {
  const current = normalizePaymentRef(settlement?.paymentRef || settlement?.transferTitle || settlement?.paymentTitle || settlement?.paymentCode || "");
  return current || buildTransferTitle(flat, settlement);
}
function shouldReplaceAccount(existingValue: any, previousDefaults: PaymentDefaults) { const existing = normalizeAccountNumber(existingValue); return !existing || existing === normalizeAccountNumber(previousDefaults.defaultAccountNumber); }
function shouldReplaceText(existingValue: any, previousDefaultValue: string) { const existing = normalizeText(existingValue); return !existing || existing === normalizeText(previousDefaultValue); }
function mergeDefaults(input: PaymentDefaults, currentCommunity: any): PaymentDefaults {
  const existing = readCommunityDefaults(currentCommunity);
  return {
    defaultAccountNumber: normalizeAccountNumber(input.defaultAccountNumber) || normalizeAccountNumber(existing.defaultAccountNumber),
    recipientName: normalizeText(input.recipientName) || normalizeText(existing.recipientName),
    recipientAddress: normalizeText(input.recipientAddress) || normalizeText(existing.recipientAddress),
  };
}

export default function ChargesPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<Settlement[]>([]);
  const [flats, setFlats] = useState<Record<string, Flat>>({});
  const [defaults, setDefaults] = useState<PaymentDefaults>({ defaultAccountNumber: "", recipientName: "", recipientAddress: "" });
  const [communityDoc, setCommunityDoc] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!communityId) return;
    let cancelled = false;

    const loadViaAdmin = async () => {
      try {
        const token = await auth.currentUser?.getIdToken();
        if (!token) return;
        const res = await fetch('/api/charges/overview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ communityId }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const drafts = Array.isArray(data?.drafts) ? data.drafts : [];
        const settlements = Array.isArray(data?.settlements) ? data.settlements : [];
        setItems(mergeSettlementsForView(drafts, settlements));
      } catch (_) {}
    };

    loadViaAdmin();
    const refreshTimer = window.setInterval(loadViaAdmin, 10000);

    const unsubFlats = onSnapshot(collection(db, "communities", communityId, "flats"), (snap) => {
      const map: Record<string, Flat> = {};
      snap.docs.forEach((d) => { map[d.id] = { id: d.id, ...(d.data() as any) }; });
      setFlats(map);
    });
    const unsubCommunity = onSnapshot(doc(db, "communities", communityId), (snap) => {
      const data: any = snap.data() || {};
      setCommunityDoc(data);
      setDefaults(readCommunityDefaults(data));
    });
    const onVisible = () => { if (!document.hidden) loadViaAdmin(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
      document.removeEventListener('visibilitychange', onVisible);
      unsubFlats();
      unsubCommunity();
    };
  }, [communityId]);

  const drafts = useMemo(() => items.filter((s) => s.__collection === SETTLEMENT_DRAFTS_COLLECTION), [items]);
  const archived = useMemo(() => items.filter((s) => s.__collection === SETTLEMENTS_COLLECTION), [items]);
  const archivedGroups = useMemo(() => archived.reduce((acc: Record<string, Settlement[]>, item) => {
    const key = String(item.archiveMonth || item.period || "bez-daty");
    (acc[key] ||= []).push(item);
    return acc;
  }, {}), [archived]);

  const saveDefaults = async () => {
    if (!communityId) return;
    const previousDefaults = readCommunityDefaults(communityDoc || {});
    const nextDefaults = mergeDefaults(defaults, communityDoc || {});
    await setDoc(doc(db, "communities", communityId), {
      defaultAccountNumber: nextDefaults.defaultAccountNumber,
      accountNumber: nextDefaults.defaultAccountNumber,
      bankAccount: nextDefaults.defaultAccountNumber,
      recipientName: nextDefaults.recipientName,
      receiverName: nextDefaults.recipientName,
      transferName: nextDefaults.recipientName,
      recipientAddress: nextDefaults.recipientAddress,
      receiverAddress: nextDefaults.recipientAddress,
      transferAddress: nextDefaults.recipientAddress,
      paymentSettings: { ...(communityDoc?.paymentSettings || {}), accountNumber: nextDefaults.defaultAccountNumber, recipientName: nextDefaults.recipientName, recipientAddress: nextDefaults.recipientAddress, updatedAtMs: Date.now() },
      paymentDefaults: { accountNumber: nextDefaults.defaultAccountNumber, recipientName: nextDefaults.recipientName, recipientAddress: nextDefaults.recipientAddress },
      updatedAtMs: Date.now(),
    }, { merge: true });

    const batch = writeBatch(db);
    items.forEach((draft) => {
      const flat = flats[draft.flatId] || null;
      const patch: Record<string, any> = { updatedAtMs: Date.now() };
      if (nextDefaults.defaultAccountNumber && shouldReplaceAccount(draft.accountNumber || draft.bankAccount, previousDefaults)) {
        patch.accountNumber = nextDefaults.defaultAccountNumber; patch.bankAccount = nextDefaults.defaultAccountNumber;
      }
      if (nextDefaults.recipientName && shouldReplaceText(draft.transferName || draft.receiverName, previousDefaults.recipientName)) {
        patch.transferName = nextDefaults.recipientName; patch.receiverName = nextDefaults.recipientName;
      }
      if (nextDefaults.recipientAddress && shouldReplaceText(draft.transferAddress || draft.receiverAddress, previousDefaults.recipientAddress)) {
        patch.transferAddress = nextDefaults.recipientAddress; patch.receiverAddress = nextDefaults.recipientAddress;
      }
      const paymentRef = pickSettlementTitle(draft, flat);
      patch.transferTitle = paymentRef; patch.paymentTitle = paymentRef; patch.paymentRef = paymentRef; patch.paymentCode = paymentRef;
      batch.set(doc(db, "communities", communityId, draft.__collection || SETTLEMENT_DRAFTS_COLLECTION, draft.id), patch, { merge: true });
    });
    await batch.commit();
    setDefaults(nextDefaults);
    setMsg("Zapisano domyślne dane do przelewu.");
  };

  const clearAllDrafts = async () => {
    if (!communityId || !window.confirm("Usunąć wszystkie szkice rozliczeń?")) return;
    try {
      const draftRefs = drafts.map((item) => doc(db, "communities", communityId, SETTLEMENT_DRAFTS_COLLECTION, item.id));
      if (!draftRefs.length) {
        setMsg("Brak szkiców do usunięcia.");
        return;
      }
      for (let i = 0; i < draftRefs.length; i += 400) {
        const batch = writeBatch(db);
        draftRefs.slice(i, i + 400).forEach((ref) => batch.delete(ref));
        await batch.commit();
      }
      setMsg(`Usunięto szkice: ${draftRefs.length}.`);
    } catch (error: any) {
      setMsg(`Błąd czyszczenia szkiców: ${error?.message || error?.details || "nieznany"}`);
    }
  };

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h2 style={{ margin: 0 }}>Rozliczenia lokali</h2>
            <p style={{ opacity: 0.8, marginTop: 6 }}>Szkice możesz usuwać lub publikować. Archiwum jest dostępne jako osobny widok miesięczny.</p>
          </div>
          <Link href="/charges/archive" className="btnGhost" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Archiwum rozliczeń</Link>
        </div>
        <div className="card" style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
          <div>Szkice: <strong>{drafts.length}</strong></div>
          <div>Archiwum: <strong>{archived.length}</strong></div>
          <button className="btn" onClick={async () => {
            const res = await fetch("/api/settlements/publish-all-drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ communityId }) });
            const data = await res.json();
            setMsg(res.ok ? `Wysłano do lokatorów: ${data.published || data.publishedCount || 0} rozliczeń.` : `Błąd: ${data.error || "nieznany"}`);
          }}>Wyślij wszystkie szkice</button>
          <button className="btnGhost" onClick={clearAllDrafts}>Wyczyść wszystkie szkice</button>
        </div>

        <div className="card" style={{ display: "grid", gap: 12 }}>
          <h3>Domyślne dane do przelewu</h3>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <input className="input" placeholder="Rachunek dla wszystkich" value={defaults.defaultAccountNumber} onChange={(e) => setDefaults((prev) => ({ ...prev, defaultAccountNumber: e.target.value }))} />
            <input className="input" placeholder="Odbiorca" value={defaults.recipientName} onChange={(e) => setDefaults((prev) => ({ ...prev, recipientName: e.target.value }))} />
            <input className="input" placeholder="Adres odbiorcy" value={defaults.recipientAddress} onChange={(e) => setDefaults((prev) => ({ ...prev, recipientAddress: e.target.value }))} />
          </div>
          <div><button className="btn" onClick={saveDefaults}>Zapisz dane wspólne</button></div>
        </div>

        {msg && <div style={{ color: "#8ef0c8" }}>{msg}</div>}

        <div style={{ display: "grid", gap: 10 }}>
          {drafts.length ? drafts.map((s) => <SettlementCard key={s.id} s={s} communityId={communityId} flat={flats[s.flatId] || null} setMsg={setMsg} defaults={defaults} buildTransferTitle={buildTransferTitle} archived={false} />) : <div style={{ color: "#8ef0c8" }}>Brak szkiców do wyświetlenia.</div>}
        </div>

        <div className="card" style={{ display: "flex", gap: 16, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          <div>Archiwum wysłanych rozliczeń: <strong>{archived.length}</strong></div>
          <div>Miesiące w archiwum: <strong>{Object.keys(archivedGroups).length}</strong></div>
          <Link href="/charges/archive" className="btnGhost" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Otwórz archiwum</Link>
        </div>
      </div>
    </RequireAuth>
  );
}

function SettlementCard({ s, communityId, flat, setMsg, defaults, archived = false, buildTransferTitle }: { s: Settlement; communityId: string; flat: Flat | null; setMsg: (v: string) => void; defaults: PaymentDefaults; archived?: boolean; buildTransferTitle: (flat: any, settlement: any) => string; }) {
  const targetCollection = archived ? SETTLEMENTS_COLLECTION : SETTLEMENT_DRAFTS_COLLECTION;
  const computedAccount = String(validAccountNumber(s.accountNumber || s.bankAccount) ? (s.accountNumber || s.bankAccount) : (validAccountNumber(flat?.accountNumber || flat?.bankAccount) ? (flat?.accountNumber || flat?.bankAccount) : (defaults.defaultAccountNumber || "")));
  const computedName = String(s.transferName || s.receiverName || flat?.recipientName || flat?.receiverName || defaults.recipientName || "");
  const computedAddress = String(s.transferAddress || s.receiverAddress || flat?.recipientAddress || flat?.receiverAddress || defaults.recipientAddress || "");
  const computedTitle = String(pickSettlementTitle(s, flat));

  const [accountNumber, setAccountNumber] = useState(computedAccount);
  const [transferName, setTransferName] = useState(computedName);
  const [transferAddress, setTransferAddress] = useState(computedAddress);
  const [transferTitle, setTransferTitle] = useState(computedTitle);

  useEffect(() => { setAccountNumber(computedAccount); }, [computedAccount, s.id]);
  useEffect(() => { setTransferName(computedName); }, [computedName, s.id]);
  useEffect(() => { setTransferAddress(computedAddress); }, [computedAddress, s.id]);
  useEffect(() => { setTransferTitle(computedTitle); }, [computedTitle, s.id]);

  const savePaymentData = async () => {
    const cleanAccount = normalizeAccountNumber(accountNumber) || normalizeAccountNumber(computedAccount);
    const cleanName = transferName.trim() || computedName;
    const cleanAddress = transferAddress.trim() || computedAddress;
    const cleanTitle = normalizePaymentRef(transferTitle) || buildTransferTitle(flat, s);
    const payload = { accountNumber: cleanAccount, bankAccount: cleanAccount, transferName: cleanName, receiverName: cleanName, transferAddress: cleanAddress, receiverAddress: cleanAddress, transferTitle: cleanTitle, paymentTitle: cleanTitle, paymentRef: cleanTitle, paymentCode: cleanTitle, updatedAtMs: Date.now() };
    await updateDoc(doc(db, "communities", communityId, targetCollection, s.id), payload);
    if (flat?.id) {
      await setDoc(doc(db, "communities", communityId, "flats", flat.id), { accountNumber: cleanAccount, bankAccount: cleanAccount, recipientName: cleanName, receiverName: cleanName, recipientAddress: cleanAddress, receiverAddress: cleanAddress, updatedAtMs: Date.now() }, { merge: true });
    }
    setTransferTitle(cleanTitle);
    setMsg(`Zapisano dane przelewu dla ${s.flatLabel || s.id}.`);
  };

  return (
    <div className="card" style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <b>{s.flatLabel || s.addressLabel || s.flatId}</b>
        <span style={{ opacity: 0.75 }}>{s.period}</span>
        <span style={{ opacity: 0.75 }}>Status: {archived ? "WYSŁANE" : "SZKIC"}</span>
        <span style={{ opacity: 0.75 }}>Saldo: {money(centsOrAmount(s.balanceCents, s.balance))}</span>
        <span style={{ opacity: 0.75 }}>Opłaty: {money(centsOrAmount(s.chargesCents ?? s.totalCents, s.total))}</span>
        <span style={{ opacity: 0.75 }}>Wpłaty: {money(centsOrAmount(s.paymentsCents, s.payments))}</span>
      </div>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <input className="input" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="Rachunek" />
        <input className="input" value={transferName} onChange={(e) => setTransferName(e.target.value)} placeholder="Odbiorca" />
        <input className="input" value={transferAddress} onChange={(e) => setTransferAddress(e.target.value)} placeholder="Adres odbiorcy" />
        <input className="input" value={transferTitle} onChange={(e) => setTransferTitle(e.target.value)} placeholder="Tytuł przelewu" />
      </div>
      <div style={{ display: "grid", gap: 4, opacity: 0.9 }}><div>Termin płatności: {s.dueDate || "—"}</div></div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button className="btnGhost" onClick={savePaymentData}>Zapisz dane przelewu</button>
        <Link href={`/settlements/${s.id}`} className="btn" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Otwórz podgląd</Link>
        {!archived ? <button className="btn" onClick={async () => {
          await savePaymentData();
          const res = await fetch("/api/settlements/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ communityId, settlementId: s.id }) });
          const data = await res.json();
          setMsg(res.ok ? `Rozliczenie ${data.settlementId} wysłane do lokatora.` : `Błąd publikacji: ${data.error || "nieznany"}`);
        }}>Wyślij do lokatora</button> : null}
        {!archived ? <button className="btnGhost" onClick={async () => {
          if (window.confirm(`Usunąć szkic ${s.id}?`)) {
            await deleteDoc(doc(db, "communities", communityId, SETTLEMENT_DRAFTS_COLLECTION, s.id));
            setMsg(`Usunięto szkic ${s.id}.`);
          }
        }}>Usuń szkic</button> : null}
        <button className="btnGhost" onClick={async () => { window.open(`/api/settlements/${s.id}/pdf?communityId=${encodeURIComponent(communityId)}`, "_blank"); }}>PDF</button>
        <button className="btnGhost" onClick={async () => {
          const res = await fetch(`/api/settlements/${s.id}/send-email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ communityId }) });
          const data = await res.json();
          setMsg(res.ok ? `Email wysłany do: ${data.email || "—"}` : `Błąd email: ${data.error || "nieznany"}`);
        }}>Wyślij email</button>
      </div>
    </div>
  );
}
