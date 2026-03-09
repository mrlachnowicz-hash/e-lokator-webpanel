"use client";
import { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot, orderBy, query, updateDoc } from "firebase/firestore";
import * as XLSX from "xlsx";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { normalizeAccountNumber } from "../../lib/server/paymentRefs";

const money = (c: unknown) => `${(Number(c || 0) / 100).toFixed(2)} PLN`;
const pickValue = (row: any, keys: string[]) => {
  for (const key of keys) {
    const direct = row?.[key];
    if (direct != null && String(direct).trim() !== "") return direct;
    const found = Object.keys(row || {}).find((k) => k.toLowerCase() === key.toLowerCase());
    if (found && String(row?.[found] ?? "").trim() !== "") return row[found];
  }
  return "";
};
const normalizePaymentRow = (row: any) => ({
  date: String(pickValue(row, ["date", "data", "bookingDate", "księgowanie", "bookingdate"])).trim(),
  title: String(pickValue(row, ["title", "opis", "description", "tytuł", "tytul"])).trim(),
  amount: String(pickValue(row, ["amount", "kwota", "value"])).trim(),
  source: String(pickValue(row, ["source", "bank", "konto", "rachunek"])).trim(),
  code: String(pickValue(row, ["code", "kod", "reference", "endtoendid", "id"])).trim(),
  payerName: String(pickValue(row, ["payerName", "nadawca", "payer", "name"])).trim(),
  payerAddress: String(pickValue(row, ["payerAddress", "adres", "address"])).trim(),
});
const flatDisplay = (flat: any) => String(flat?.flatLabel || `${flat?.street || flat?.streetName || ""} ${flat?.buildingNo || ""}/${flat?.apartmentNo || flat?.flatNumber || ""}`.trim() || flat?.id || "—");

function parseBankXml(xmlText: string) {
  const xml = new DOMParser().parseFromString(xmlText, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("Nie udało się odczytać XML wyciągu.");
  const entries = Array.from(xml.querySelectorAll("Ntry, entry, transaction, Tx, Operacja"));
  return entries.map((node) => ({
    date: node.querySelector("BookgDt Dt, ValDt Dt, date, DataOperacji")?.textContent || "",
    amount: node.querySelector("Amt, amount, Kwota")?.textContent || "",
    title: node.querySelector("Ustrd, AddtlNtryInf, title, Opis")?.textContent || "",
    source: node.querySelector("Nm, Dbtr Nm, Cdtr Nm, source, Bank")?.textContent || "",
    code: node.querySelector("EndToEndId, InstrId, code, Kod")?.textContent || "",
    payerName: node.querySelector("Dbtr Nm, Cdtr Nm, payerName, Nadawca")?.textContent || "",
    payerAddress: node.querySelector("Dbtr PstlAdr AdrLine, Cdtr PstlAdr AdrLine, payerAddress, Adres")?.textContent || "",
  }));
}

async function readImportFile(file: File) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".xml")) return parseBankXml(await file.text());
  if (lower.endsWith(".csv")) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const utf8 = new TextDecoder("utf-8").decode(bytes);
    const fallback1250 = new TextDecoder("windows-1250").decode(bytes);
    const csvText = utf8.includes("�") && !fallback1250.includes("�") ? fallback1250 : utf8;
    const wb = XLSX.read(csvText, { type: "string" });
    const ws = wb.Sheets[wb.SheetNames[0]!];
    return XLSX.utils.sheet_to_json(ws, { defval: "" }) as any[];
  }
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer);
  const ws = wb.Sheets[wb.SheetNames[0]!];
  return XLSX.utils.sheet_to_json(ws, { defval: "" }) as any[];
}

export default function PaymentsPage() {
  const { user, profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [payments, setPayments] = useState<any[]>([]);
  const [flats, setFlats] = useState<any[]>([]);
  const [settlements, setSettlements] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const [busyId, setBusyId] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settings, setSettings] = useState({ accountNumber: "", recipientName: "", recipientAddress: "", automationMode: "MANUAL_ONLY", automationSource: "", automationLogin: "" });

  useEffect(() => {
    if (!communityId) return;
    const u1 = onSnapshot(query(collection(db, "communities", communityId, "payments"), orderBy("createdAtMs", "desc")), (s) => setPayments(s.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
    const u2 = onSnapshot(collection(db, "communities", communityId, "flats"), (s) => setFlats(s.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
    const u3 = onSnapshot(collection(db, "communities", communityId, "settlements"), (s) => setSettlements(s.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
    const u4 = onSnapshot(doc(db, "communities", communityId), (snap) => {
      const data: any = snap.data() || {};
      setSettings({
        accountNumber: String(data.defaultAccountNumber || data.accountNumber || data.bankAccount || data.paymentSettings?.accountNumber || ""),
        recipientName: String(data.recipientName || data.receiverName || data.paymentSettings?.recipientName || data.name || ""),
        recipientAddress: String(data.recipientAddress || data.receiverAddress || data.paymentSettings?.recipientAddress || ""),
        automationMode: String(data.paymentSettings?.automationMode || "MANUAL_ONLY"),
        automationSource: String(data.paymentSettings?.automationSource || ""),
        automationLogin: String(data.paymentSettings?.automationLogin || ""),
      });
    });
    return () => { u1(); u2(); u3(); u4(); };
  }, [communityId]);

  const flatById = useMemo(() => new Map(flats.map((f) => [f.id, f])), [flats]);
  const settlementById = useMemo(() => new Map(settlements.map((s) => [s.id, s])), [settlements]);
  const flatStatus = useMemo(() => flats.map((flat) => {
    const related = settlements.filter((s) => s.flatId === flat.id).sort((a, b) => Number(b.updatedAtMs || b.createdAtMs || 0) - Number(a.updatedAtMs || a.createdAtMs || 0));
    const latest = related[0];
    const balance = Number(latest?.balanceCents || 0);
    return {
      flat,
      residentName: String(latest?.residentName || flat.residentName || flat.displayName || `${flat.name || ""} ${flat.surname || flat.lastName || ""}`.trim() || "—"),
      payerName: String(latest?.payerName || latest?.residentName || flat.displayName || ""),
      status: latest ? (balance <= 0 ? "PAID" : "UNPAID") : "NO_SETTLEMENT",
      paymentTitle: String(latest?.paymentTitle || latest?.transferTitle || ""),
      balanceCents: balance,
    };
  }), [flats, settlements]);
  const stats = useMemo(() => ({ total: payments.length, matched: payments.filter((p) => p.matched || String(p.status || "").toUpperCase() === "MATCHED").length, review: payments.filter((p) => !p.matched && String(p.status || "").toUpperCase() === "REVIEW").length }), [payments]);

  async function saveSettings() {
    if (!communityId) return;
    setSettingsBusy(true);
    setMsg("");
    try {
      const normalizedAccount = normalizeAccountNumber(settings.accountNumber);
      await updateDoc(doc(db, "communities", communityId), {
        defaultAccountNumber: normalizedAccount,
        accountNumber: normalizedAccount,
        bankAccount: normalizedAccount,
        recipientName: settings.recipientName.trim(),
        receiverName: settings.recipientName.trim(),
        transferName: settings.recipientName.trim(),
        recipientAddress: settings.recipientAddress.trim(),
        receiverAddress: settings.recipientAddress.trim(),
        transferAddress: settings.recipientAddress.trim(),
        paymentSettings: {
          accountNumber: normalizedAccount,
          recipientName: settings.recipientName.trim(),
          recipientAddress: settings.recipientAddress.trim(),
          automationMode: settings.automationMode,
          automationSource: settings.automationSource.trim(),
          automationLogin: settings.automationLogin.trim(),
          updatedAtMs: Date.now(),
        },
        paymentDefaults: {
          accountNumber: normalizedAccount,
          recipientName: settings.recipientName.trim(),
          recipientAddress: settings.recipientAddress.trim(),
        },
        updatedAtMs: Date.now(),
      });
      setMsg("Zapisano dane do przelewów i konfigurację automatyzacji.");
    } finally { setSettingsBusy(false); }
  }

  return <RequireAuth roles={["MASTER", "ACCOUNTANT"]}><Nav /><div style={{ padding: 24, display: "grid", gap: 16 }}><h2>Przelewy i rozpoznawanie wpłat</h2><div className="card" style={{ display: "flex", gap: 18, flexWrap: "wrap" }}><div>Łącznie: <strong>{stats.total}</strong></div><div>Dopasowane: <strong>{stats.matched}</strong></div><div>Do review: <strong>{stats.review}</strong></div></div><div className="card" style={{ display: "grid", gap: 12 }}><h3>Dane do przelewów</h3><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}><input className="input" placeholder="Numer konta" value={settings.accountNumber} onChange={(e) => setSettings((s) => ({ ...s, accountNumber: e.target.value }))} /><input className="input" placeholder="Odbiorca" value={settings.recipientName} onChange={(e) => setSettings((s) => ({ ...s, recipientName: e.target.value }))} /><input className="input" placeholder="Adres odbiorcy" value={settings.recipientAddress} onChange={(e) => setSettings((s) => ({ ...s, recipientAddress: e.target.value }))} /></div><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}><select className="select" value={settings.automationMode} onChange={(e) => setSettings((s) => ({ ...s, automationMode: e.target.value }))}><option value="MANUAL_ONLY">Tylko ręczny import</option><option value="PREPARED_AUTOMATION">Automatyczny pobór — konfiguracja przygotowana</option></select><input className="input" placeholder="Źródło / bank / skrzynka importu" value={settings.automationSource} onChange={(e) => setSettings((s) => ({ ...s, automationSource: e.target.value }))} /><input className="input" placeholder="Login / identyfikator automatyzacji" value={settings.automationLogin} onChange={(e) => setSettings((s) => ({ ...s, automationLogin: e.target.value }))} /></div><div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}><button className="btn" disabled={settingsBusy} onClick={saveSettings}>{settingsBusy ? "Zapisywanie..." : "Zapisz konfigurację"}</button><div style={{ opacity: 0.78 }}>Tryb automatyczny ma gotowy punkt konfiguracji i zapis danych. Codzienny pobór wyciągu wymaga jeszcze zewnętrznej integracji i sekretów banku.</div></div></div><div className="card" style={{ display: "grid", gap: 12 }}><h3>Ręczny import wyciągu</h3><p style={{ opacity: 0.8, marginTop: -4 }}>Obsługiwane pliki: CSV, XLSX, XLS, XML (np. wyciągi bankowe). Kolumny: date/data, title/opis, amount/kwota, source/bank, code/kod, payerName/nadawca, payerAddress/adres.</p><input type="file" accept=".csv,.xlsx,.xls,.xml" onChange={async (e) => { const file = e.target.files?.[0]; if (!file || !communityId || !user) return; setMsg(""); try { const raw = await readImportFile(file); const rows = raw.map(normalizePaymentRow).filter((x: any) => x.title || x.amount || x.code || x.payerName); const token = await user.getIdToken(); const res = await fetch("/api/payments/import", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ communityId, rows }) }); const data = await res.json(); if (!res.ok) throw new Error(data.error || "Błąd importu przelewów"); setMsg(`Zaimportowano wyciąg. Dopasowane: ${data.matched || 0}, review: ${data.unmatched || 0}, duplikaty: ${data.duplicates || 0}.`); } catch (error: any) { setMsg(error?.message || "Błąd importu przelewów."); } finally { e.currentTarget.value = ""; } }} />{msg ? <div style={{ color: "#8ef0c8" }}>{msg}</div> : null}</div><div className="card" style={{ display: "grid", gap: 12 }}><h3>Status rozliczeń lokali</h3><div style={{ display: "grid", gap: 8 }}>{flatStatus.map((row) => <div key={row.flat.id} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr auto", gap: 10, alignItems: "center", borderTop: "1px solid rgba(255,255,255,.08)", paddingTop: 8 }}><div><strong>{flatDisplay(row.flat)}</strong></div><div>{row.residentName}</div><div>{row.payerName || "—"}</div><div>{row.paymentTitle || "—"}</div><div style={{ fontWeight: 700, color: row.status === "PAID" ? "#6ee7b7" : row.status === "UNPAID" ? "#fca5a5" : "#facc15" }}>{row.status === "PAID" ? `✔ Zapłacone (${money(Math.max(0, -row.balanceCents))})` : row.status === "UNPAID" ? `! Brak wpłaty (${money(row.balanceCents)})` : "— Brak rozliczenia"}</div></div>)}</div></div><div style={{ display: "grid", gap: 10 }}>{payments.slice(0, 200).map((p) => { const flat = flatById.get(String(p.flatId || "")); const settlement = settlementById.get(String(p.settlementId || "")); const needsReview = !p.matched && String(p.status || "").toUpperCase() === "REVIEW"; return <div key={p.id} className="card" style={{ display: "grid", gap: 8 }}><div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}><strong>{flatDisplay(flat) || settlement?.flatLabel || "brak dopasowania"}</strong><span>{p.payerName || settlement?.residentName || "—"}</span><span>{p.period || "—"}</span><span>{p.title || p.source || "Wpłata"}</span><span>{money(p.amountCents)}</span><span>{p.code || "—"}</span><span style={{ color: needsReview ? "#fca5a5" : "#6ee7b7" }}>{needsReview ? "Review" : "Dopasowane"}</span></div><div style={{ opacity: 0.82 }}>{p.matchReason || p.aiSuggestion?.reason || "—"}</div>{needsReview ? <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}><button className="btnGhost" onClick={async () => { setBusyId(p.id); try { const res = await fetch("/api/ai/payment-apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ communityId, paymentId: p.id }) }); const data = await res.json(); if (!res.ok) throw new Error(data.error || "AI payment error"); setMsg(data.applied ? `AI dopasowało wpłatę do ${data.settlementId}.` : "AI nadal wymaga review."); } catch (error: any) { setMsg(error?.message || "Błąd AI."); } finally { setBusyId(""); } }}>{busyId === p.id ? "AI..." : "Spróbuj AI"}</button></div> : null}</div>; })}</div></div></RequireAuth>;
}
