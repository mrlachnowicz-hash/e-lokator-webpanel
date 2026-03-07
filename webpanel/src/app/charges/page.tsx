"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { collection, deleteDoc, doc, getDoc, onSnapshot, orderBy, query, setDoc, updateDoc, writeBatch } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";

type Settlement = any;
type Flat = any;

function money(v: any) { return `${Number(v || 0).toFixed(2)} PLN`; }
function centsOrAmount(cents: any, amount: any) { if (cents != null) return Number(cents) / 100; return Number(amount || 0); }
function monthLabel(period: string) {
  const names = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];
  const m = String(period || "").match(/^(\d{4})-(\d{2})/);
  if (!m) return period || "bez daty";
  return `${names[Number(m[2]) - 1] || m[2]} ${m[1]}`;
}
function transferCode(flat: any) {
  return String(flat?.paymentCode || flat?.flatLabel || `${flat?.street || ""}-${flat?.buildingNo || ""}-${flat?.apartmentNo || ""}`)
    .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 18) || "LOKAL";
}

function buildTransferTitle(flat: any, settlement: any) {
  const period = String(settlement?.period || "").replace(/[^0-9]/g, "").slice(0, 6) || new Date().toISOString().slice(0, 7).replace(/-/g, "");
  const suffix = String(flat?.id || settlement?.flatId || "XXXX").replace(/[^A-Za-z0-9]/g, "").slice(-4).toUpperCase() || "XXXX";
  return `EL ${transferCode(flat || settlement)} ${period} ${suffix}`.trim();
}

export default function ChargesPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<Settlement[]>([]);
  const [flats, setFlats] = useState<Record<string, Flat>>({});
  const [defaults, setDefaults] = useState({ defaultAccountNumber: "", recipientName: "", recipientAddress: "" });
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!communityId) return;
    const unsubSettlements = onSnapshot(query(collection(db, "communities", communityId, "settlements"), orderBy("updatedAtMs", "desc")), (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
    const unsubFlats = onSnapshot(query(collection(db, "communities", communityId, "flats")), (snap) => {
      const map: Record<string, Flat> = {};
      snap.docs.forEach((d) => { map[d.id] = { id: d.id, ...(d.data() as any) }; });
      setFlats(map);
    });
    getDoc(doc(db, "communities", communityId)).then((snap) => {
      const data: any = snap.data() || {};
      setDefaults({ defaultAccountNumber: String(data.defaultAccountNumber || data.accountNumber || ""), recipientName: String(data.recipientName || data.name || ""), recipientAddress: String(data.recipientAddress || "") });
    });
    return () => { unsubSettlements(); unsubFlats(); };
  }, [communityId]);

  const drafts = useMemo(() => items.filter((s) => s.isPublished !== true), [items]);
  const archived = useMemo(() => items.filter((s) => s.isPublished === true), [items]);
  const archivedGroups = useMemo(() => archived.reduce((acc: Record<string, Settlement[]>, item) => { const key = String(item.archiveMonth || item.period || "bez-daty"); (acc[key] ||= []).push(item); return acc; }, {}), [archived]);

  const saveDefaults = async () => {
    await setDoc(doc(db, "communities", communityId), { defaultAccountNumber: defaults.defaultAccountNumber.trim(), accountNumber: defaults.defaultAccountNumber.trim(), recipientName: defaults.recipientName.trim(), recipientAddress: defaults.recipientAddress.trim(), updatedAtMs: Date.now() }, { merge: true });
    setMsg("Zapisano domyślne dane do przelewu.");
  };

  const clearAllDrafts = async () => {
    if (!window.confirm("Usunąć wszystkie szkice rozliczeń?")) return;
    const batch = writeBatch(db);
    drafts.forEach((item) => batch.delete(doc(db, "communities", communityId, "settlements", item.id)));
    await batch.commit();
    setMsg(`Usunięto szkice: ${drafts.length}.`);
  };

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Rozliczenia lokali</h2>
        <p style={{ opacity: 0.8, marginTop: -8 }}>Szkice możesz usuwać lub publikować. Po wysłaniu rozliczenie trafia do archiwum i jest grupowane miesiącami.</p>
        <div className="card" style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
          <div>Szkice: <strong>{drafts.length}</strong></div>
          <div>Archiwum: <strong>{archived.length}</strong></div>
          <button className="btn" onClick={async () => {
            const res = await fetch("/api/settlements/publish-all-drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ communityId }) });
            const data = await res.json();
            setMsg(res.ok ? `Wysłano do lokatorów: ${data.published || 0} rozliczeń.` : `Błąd: ${data.error || "nieznany"}`);
          }}>Wyślij wszystkie szkice</button>
          <button className="btnGhost" onClick={clearAllDrafts}>Wyczyść wszystkie szkice</button>
        </div>

        <div className="card" style={{ display: "grid", gap: 12 }}>
          <h3>Domyślne dane do przelewu</h3>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <input className="input" placeholder="Rachunek dla wszystkich" value={defaults.defaultAccountNumber} onChange={(e) => setDefaults({ ...defaults, defaultAccountNumber: e.target.value })} />
            <input className="input" placeholder="Odbiorca" value={defaults.recipientName} onChange={(e) => setDefaults({ ...defaults, recipientName: e.target.value })} />
            <input className="input" placeholder="Adres odbiorcy" value={defaults.recipientAddress} onChange={(e) => setDefaults({ ...defaults, recipientAddress: e.target.value })} />
          </div>
          <div><button className="btn" onClick={saveDefaults}>Zapisz dane wspólne</button></div>
        </div>

        {msg && <div style={{ color: "#8ef0c8" }}>{msg}</div>}

        <div style={{ display: "grid", gap: 10 }}>
          {drafts.map((s) => <SettlementCard key={s.id} s={s} communityId={communityId} flat={flats[s.flatId] || null} setMsg={setMsg} defaults={defaults} />)}
        </div>

        <div className="card" style={{ display: "grid", gap: 12 }}>
          <h3>Archiwum wysłanych rozliczeń</h3>
          {Object.keys(archivedGroups).length === 0 ? <div style={{ opacity: 0.7 }}>Brak archiwum.</div> : Object.entries(archivedGroups).sort((a, b) => b[0].localeCompare(a[0])).map(([period, rows]) => (
            <div key={period} style={{ display: "grid", gap: 10 }}>
              <strong>{monthLabel(period)}</strong>
              {rows.map((s) => <SettlementCard key={s.id} s={s} communityId={communityId} flat={flats[s.flatId] || null} setMsg={setMsg} defaults={defaults} archived />)}
            </div>
          ))}
        </div>
      </div>
    </RequireAuth>
  );
}

function SettlementCard({ s, communityId, flat, setMsg, defaults, archived = false }: { s: Settlement; communityId: string; flat: Flat | null; setMsg: (v: string) => void; defaults: any; archived?: boolean }) {
  const [accountNumber, setAccountNumber] = useState(String(s.accountNumber || flat?.accountNumber || defaults.defaultAccountNumber || ""));
  const [transferName, setTransferName] = useState(String(s.transferName || flat?.recipientName || defaults.recipientName || ""));
  const [transferAddress, setTransferAddress] = useState(String(s.transferAddress || flat?.recipientAddress || defaults.recipientAddress || ""));
  const [transferTitle, setTransferTitle] = useState(String(s.transferTitle || s.paymentTitle || buildTransferTitle(flat, s)));
  const savePaymentData = async () => {
    const payload = { accountNumber: accountNumber.trim(), transferName: transferName.trim(), transferAddress: transferAddress.trim(), transferTitle: transferTitle.trim(), paymentTitle: transferTitle.trim(), updatedAtMs: Date.now() };
    await updateDoc(doc(db, "communities", communityId, "settlements", s.id), payload);
    if (flat?.id) await setDoc(doc(db, "communities", communityId, "flats", flat.id), { accountNumber: accountNumber.trim(), recipientName: transferName.trim(), recipientAddress: transferAddress.trim(), updatedAtMs: Date.now() }, { merge: true });
    setMsg(`Zapisano dane przelewu dla ${s.flatLabel || s.id}.`);
  };
  return (
    <div className="card" style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <b>{s.flatLabel || s.addressLabel || s.flatId}</b>
        <span style={{ opacity: 0.75 }}>{s.period}</span>
        <span style={{ opacity: 0.75 }}>Status: {s.isPublished ? "WYSŁANE" : "SZKIC"}</span>
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
      <div style={{ display: "grid", gap: 4, opacity: 0.9 }}>
        <div>Termin płatności: {s.dueDate || "—"}</div>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button className="btnGhost" onClick={savePaymentData}>Zapisz dane przelewu</button>
        <Link href={`/settlements/${s.id}`} className="btn" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Otwórz podgląd</Link>
        {!s.isPublished ? <button className="btn" onClick={async () => {
          await savePaymentData();
          const res = await fetch(`/api/settlements/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ communityId, settlementId: s.id }) });
          const data = await res.json();
          setMsg(res.ok ? `Rozliczenie ${data.settlementId} wysłane do lokatora.` : `Błąd publikacji: ${data.error || "nieznany"}`);
        }}>Wyślij do lokatora</button> : null}
        {!archived ? <button className="btnGhost" onClick={async () => { if (window.confirm(`Usunąć szkic ${s.id}?`)) { await deleteDoc(doc(db, "communities", communityId, "settlements", s.id)); setMsg(`Usunięto szkic ${s.id}.`); } }}>Usuń szkic</button> : null}
        <button className="btnGhost" onClick={async () => { const url = `/api/settlements/${s.id}/pdf?communityId=${encodeURIComponent(communityId)}`; window.open(url, "_blank"); }}>PDF</button>
        <button className="btnGhost" onClick={async () => { const res = await fetch(`/api/settlements/${s.id}/send-email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ communityId }) }); const data = await res.json(); setMsg(res.ok ? `Email wysłany do: ${data.email || "—"}` : `Błąd email: ${data.error || "nieznany"}`); }}>Wyślij email</button>
      </div>
    </div>
  );
}
