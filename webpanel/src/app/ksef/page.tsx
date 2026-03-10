"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { Nav } from "@/components/Nav";
import { RequireAuth } from "@/components/RequireAuth";
import { useAuth } from "@/lib/authContext";
import { db } from "@/lib/firebase";
import { callable } from "@/lib/functions";

const setConfig = callable<any, any>("ksefSetConfig");
const fetchInvoices = callable<any, any>("ksefFetchInvoices");
const retryInvoices = callable<any, any>("ksefRetryNow");

export default function KsefPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [form, setForm] = useState({
    environment: "MOCK",
    nip: "",
    identifier: "",
    token: "",
    subjectType: "Subject2",
    syncFrom: "",
    syncTo: "",
    autoSyncEnabled: false,
    autoSyncIntervalMinutes: 60,
    autoSyncCount: 5,
    retryEnabled: true,
    retryMaxAttempts: 3,
    retryDelayMinutes: 15,
    dedupeEnabled: true,
  });
  const [status, setStatus] = useState<any>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!communityId) return;
    return onSnapshot(doc(db, "communities", communityId, "ksef", "config"), (snap) => {
      const data: any = snap.data() || {};
      setStatus(data || null);
      setForm((prev) => ({
        ...prev,
        environment: String(data.environment || data.mode || prev.environment || "MOCK").toUpperCase(),
        nip: String(data.nip || ""),
        identifier: String(data.identifier || ""),
        token: String(data.token || ""),
        subjectType: String(data.subjectType || "Subject2"),
        syncFrom: String(data.syncFrom || ""),
        syncTo: String(data.syncTo || ""),
        autoSyncEnabled: data.autoSyncEnabled === true,
        autoSyncIntervalMinutes: Number(data.autoSyncIntervalMinutes || 60),
        autoSyncCount: Number(data.autoSyncCount || 5),
        retryEnabled: data.retryEnabled !== false,
        retryMaxAttempts: Number(data.retryMaxAttempts || 3),
        retryDelayMinutes: Number(data.retryDelayMinutes || 15),
        dedupeEnabled: data.dedupeEnabled !== false,
      }));
    });
  }, [communityId]);

  async function save() {
    if (!communityId) return;
    setBusy(true);
    setMsg("");
    try {
      await setConfig({ communityId, ...form });
      setMsg("Zapisano konfigurację KSeF.");
    } catch (e: any) {
      setMsg(e?.message || "Błąd zapisu konfiguracji KSeF.");
    } finally {
      setBusy(false);
    }
  }

  async function fetchNow() {
    if (!communityId) return;
    setBusy(true);
    setMsg("");
    try {
      const res: any = await fetchInvoices({ communityId, mode: form.environment, count: form.autoSyncCount });
      const created = Number(res?.data?.created?.length || 0);
      const duplicates = Number(res?.data?.duplicates?.length || 0);
      setMsg(`Pobrano z KSeF: ${created} faktur, pominięto duplikaty: ${duplicates}.`);
    } catch (e: any) {
      setMsg(e?.message || "Błąd pobierania z KSeF.");
    } finally {
      setBusy(false);
    }
  }


  async function retryNow() {
    if (!communityId) return;
    setBusy(true);
    setMsg("");
    try {
      const res: any = await retryInvoices({ communityId, mode: form.environment, count: form.autoSyncCount });
      const created = Number(res?.data?.created?.length || 0);
      const duplicates = Number(res?.data?.duplicates?.length || 0);
      setMsg(`Retry KSeF zakończony. Dodano: ${created}, duplikaty: ${duplicates}.`);
    } catch (e: any) {
      setMsg(e?.message || "Błąd retry KSeF.");
    } finally {
      setBusy(false);
    }
  }

  const statusLine = status ? [
    status.syncInProgress ? "Synchronizacja w toku" : "Gotowe",
    status.lastSyncSuccessAtMs ? `ostatni sukces: ${new Date(status.lastSyncSuccessAtMs).toLocaleString()}` : "brak udanego sync",
    status.lastSyncError ? `ostatni błąd: ${status.lastSyncError}` : "bez błędów",
    typeof status.lastSyncDuplicates === "number" ? `duplikaty: ${status.lastSyncDuplicates}` : "",
  ].filter(Boolean).join(" · ") : "";

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16, maxWidth: 980 }}>
        <h1 style={{ margin: 0 }}>Ustaw KSeF</h1>
        <div className="card" style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <select className="select" value={form.environment} onChange={(e) => setForm((p) => ({ ...p, environment: e.target.value }))}>
              <option value="MOCK">MOCK</option>
              <option value="TEST">TEST</option>
              <option value="PRODUCTION">PRODUCTION</option>
            </select>
            <input className="input" placeholder="NIP wspólnoty" value={form.nip} onChange={(e) => setForm((p) => ({ ...p, nip: e.target.value }))} />
            <input className="input" placeholder="Identifier / podmiot" value={form.identifier} onChange={(e) => setForm((p) => ({ ...p, identifier: e.target.value }))} />
            <select className="select" value={form.subjectType} onChange={(e) => setForm((p) => ({ ...p, subjectType: e.target.value }))}>
              <option value="Subject2">Subject2</option>
              <option value="Subject1">Subject1</option>
            </select>
            <input className="input" type="date" value={form.syncFrom} onChange={(e) => setForm((p) => ({ ...p, syncFrom: e.target.value }))} />
            <input className="input" type="date" value={form.syncTo} onChange={(e) => setForm((p) => ({ ...p, syncTo: e.target.value }))} />
          </div>
          <textarea className="input" placeholder="Token KSeF" value={form.token} onChange={(e) => setForm((p) => ({ ...p, token: e.target.value }))} style={{ minHeight: 120 }} />
          <div className="card" style={{ display: "grid", gap: 12 }}>
            <strong>Automatyzacja KSeF</strong>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={form.autoSyncEnabled} onChange={(e) => setForm((p) => ({ ...p, autoSyncEnabled: e.target.checked }))} />
              Auto-pobieranie faktur co określony interwał
            </label>
            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
              <input className="input" type="number" min={15} step={15} value={form.autoSyncIntervalMinutes} onChange={(e) => setForm((p) => ({ ...p, autoSyncIntervalMinutes: Number(e.target.value || 60) }))} placeholder="Interwał minut" />
              <input className="input" type="number" min={1} max={20} value={form.autoSyncCount} onChange={(e) => setForm((p) => ({ ...p, autoSyncCount: Number(e.target.value || 5) }))} placeholder="Ile faktur na sync" />
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={form.retryEnabled} onChange={(e) => setForm((p) => ({ ...p, retryEnabled: e.target.checked }))} />
              Retry po błędzie synchronizacji
            </label>
            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
              <input className="input" type="number" min={1} max={10} value={form.retryMaxAttempts} onChange={(e) => setForm((p) => ({ ...p, retryMaxAttempts: Number(e.target.value || 3) }))} placeholder="Maks. prób" />
              <input className="input" type="number" min={5} max={1440} value={form.retryDelayMinutes} onChange={(e) => setForm((p) => ({ ...p, retryDelayMinutes: Number(e.target.value || 15) }))} placeholder="Opóźnienie retry" />
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={form.dedupeEnabled} onChange={(e) => setForm((p) => ({ ...p, dedupeEnabled: e.target.checked }))} />
              Blokuj duplikaty faktur KSeF
            </label>
            {statusLine ? <div style={{ opacity: 0.8 }}>{statusLine}</div> : null}
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn" onClick={save} disabled={busy}>Zapisz KSeF</button>
            <button className="btnGhost" onClick={fetchNow} disabled={busy}>Pobierz z KSeF</button>
            <button className="btnGhost" onClick={retryNow} disabled={busy}>Retry teraz</button>
          </div>
          {msg ? <div style={{ color: "#8ef0c8" }}>{msg}</div> : null}
        </div>
      </div>
    </RequireAuth>
  );
}
