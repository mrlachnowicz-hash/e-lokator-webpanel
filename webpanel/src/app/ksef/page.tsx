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
  });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!communityId) return;
    return onSnapshot(doc(db, "communities", communityId, "ksef", "config"), (snap) => {
      const data: any = snap.data() || {};
      setForm((prev) => ({
        ...prev,
        environment: String(data.environment || data.mode || prev.environment || "MOCK").toUpperCase(),
        nip: String(data.nip || ""),
        identifier: String(data.identifier || ""),
        token: String(data.token || ""),
        subjectType: String(data.subjectType || "Subject2"),
        syncFrom: String(data.syncFrom || ""),
        syncTo: String(data.syncTo || ""),
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
      const res: any = await fetchInvoices({ communityId, mode: form.environment, count: 5 });
      const created = Number(res?.data?.created?.length || 0);
      setMsg(`Pobrano z KSeF: ${created} faktur.`);
    } catch (e: any) {
      setMsg(e?.message || "Błąd pobierania z KSeF.");
    } finally {
      setBusy(false);
    }
  }

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
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn" onClick={save} disabled={busy}>Zapisz KSeF</button>
            <button className="btnGhost" onClick={fetchNow} disabled={busy}>Pobierz z KSeF</button>
          </div>
          {msg ? <div style={{ color: "#8ef0c8" }}>{msg}</div> : null}
        </div>
      </div>
    </RequireAuth>
  );
}
