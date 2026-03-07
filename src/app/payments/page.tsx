"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { callable } from "../../lib/functions";

type Payment = any;
type Flat = { id: string; flatLabel?: string; street?: string; buildingNo?: string; apartmentNo?: string; residentName?: string; displayName?: string };

function paymentStatusLabel(p: any) {
  const raw = String(p.status || p.matchedBy || "").toUpperCase();
  if (raw === "CODE" || raw === "MATCHED") return "CODE · dopasowane";
  if (raw === "AI_HINT" || raw === "AI" || raw.includes("AI")) return "AI_HINT · dopasowane AI";
  if (p.matched) return "CODE · dopasowane";
  return "REVIEW · do sprawdzenia";
}

function normalizePaymentRow(r: any) {
  const pick = (...keys: string[]) => keys.map((k) => r[k]).find((v) => v != null && String(v).trim() !== "") ?? "";
  return {
    date: String(pick("date", "data", "bookingDate")).trim(),
    title: String(pick("title", "opis", "tytul", "tytuł", "description")).trim(),
    amount: String(pick("amount", "kwota", "value")).trim(),
    source: String(pick("source", "bank", "konto")).trim(),
    code: String(pick("code", "kod")).trim(),
  };
}

function moneyCents(v: any) {
  return `${(Number(v || 0) / 100).toFixed(2)} PLN`;
}

export default function PaymentsPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<Payment[]>([]);
  const [flats, setFlats] = useState<Flat[]>([]);
  const [msg, setMsg] = useState("");
  const [busyId, setBusyId] = useState("");

  useEffect(() => {
    if (!communityId) return;
    const q = query(collection(db, "communities", communityId, "payments"), orderBy("createdAtMs", "desc"));
    const unsubPayments = onSnapshot(q, (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
    const unsubFlats = onSnapshot(collection(db, "communities", communityId, "flats"), (snap) => setFlats(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
    return () => {
      unsubPayments();
      unsubFlats();
    };
  }, [communityId]);

  const flatById = useMemo(() => new Map(flats.map((f) => [f.id, f])), [flats]);
  const stats = useMemo(() => ({
    total: items.length,
    matched: items.filter((p) => p.matched || String(p.status || "").toUpperCase() !== "REVIEW").length,
    review: items.filter((p) => !(p.matched || String(p.status || "").toUpperCase() !== "REVIEW")).length,
  }), [items]);

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Import przelewów</h2>
        <p style={{ opacity: 0.8, marginTop: -8 }}>Najpierw działa system: kod EL, lokal, nazwisko, adres, kwota. Dopiero gdy to nie wystarcza, używamy AI do sugestii dopasowania.</p>
        <div className="card" style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          <div>Łącznie: <strong>{stats.total}</strong></div>
          <div>Dopasowane: <strong>{stats.matched}</strong></div>
          <div>Review: <strong>{stats.review}</strong></div>
        </div>
        <div className="card" style={{ display: "grid", gap: 12 }}>
          <p>System dopasowuje przelewy najpierw po kodzie, potem heurystycznie. AI uruchamiasz tylko dla nierozpoznanych wpłat.</p>
          <input type="file" accept=".csv,.xlsx,.xls" onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const buf = await file.arrayBuffer();
            const wb = XLSX.read(buf);
            const ws = wb.Sheets[wb.SheetNames[0]!];
            const json = XLSX.utils.sheet_to_json(ws, { defval: "" }) as any[];
            const rows = json.map(normalizePaymentRow);
            const res = await callable("importPayments")({ communityId, rows });
            const data = (res as any).data || {};
            setMsg(`Zaimportowano. Dopasowane: ${data.matched || 0}, review: ${data.unmatched || 0}.`);
          }} />
          {msg ? <div style={{ color: "#8ef0c8" }}>{msg}</div> : null}
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          {items.slice(0, 200).map((p) => {
            const flat = flatById.get(String(p.flatId || ""));
            const flatLabel = flat?.flatLabel || (flat ? `${flat.street || ""} ${flat.buildingNo || ""}/${flat.apartmentNo || ""}`.trim() : "");
            const residentName = flat?.residentName || flat?.displayName || "";
            const needsAI = !(p.matched || String(p.status || "").toUpperCase() === "AI_HINT" || String(p.status || "").toUpperCase() === "CODE");
            return (
              <div key={p.id} className="card" style={{ display: "grid", gap: 8 }}>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                  <strong>{flatLabel || p.flatId || "brak dopasowania"}</strong>
                  {residentName ? <span>{residentName}</span> : null}
                  <span>{p.period || "—"}</span>
                  <span>{p.title || p.source || "Wpłata"}</span>
                  <span>{moneyCents(p.amountCents)}</span>
                  <span>{p.code || "—"}</span>
                  <span>{paymentStatusLabel(p)}</span>
                </div>
                {p.aiSuggestion ? <div style={{ opacity: 0.82 }}>AI: {p.aiSuggestion.reason || "sugestia"} · conf {Number(p.aiSuggestion.confidence || 0).toFixed(2)}</div> : null}
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {needsAI ? <button className="btnGhost" onClick={async () => {
                    setBusyId(p.id);
                    try {
                      const res = await fetch("/api/ai/payment-apply", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ communityId, paymentId: p.id }),
                      });
                      const data = await res.json();
                      if (!res.ok) throw new Error(data.error || "AI payment error");
                      setMsg(data.applied ? `AI dopasowało wpłatę do ${data.settlementId}.` : "AI nie było wystarczająco pewne. Rekord trafił do review.");
                    } catch (error: any) {
                      setMsg(error?.message || "Błąd AI.");
                    } finally {
                      setBusyId("");
                    }
                  }}>{busyId === p.id ? "AI..." : "Spróbuj AI"}</button> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </RequireAuth>
  );
}
