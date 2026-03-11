"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { collection, deleteDoc, doc, onSnapshot, query, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/authContext";
import { Nav } from "@/components/Nav";
import { RequireAuth } from "@/components/RequireAuth";
import { SETTLEMENTS_COLLECTION } from "@/lib/settlementCollections";

type Settlement = any;

function monthLabel(period: string) {
  const names = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];
  const m = String(period || "").match(/^(\d{4})-(\d{2})/);
  if (!m) return period || "bez daty";
  return `${names[Number(m[2]) - 1] || m[2]} ${m[1]}`;
}
function moneyCents(v: any) { return `${(Number(v || 0) / 100).toFixed(2)} PLN`; }

export default function ChargesArchivePage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<Settlement[]>([]);
  const [selectedMonth, setSelectedMonth] = useState("");
  const [busyMonth, setBusyMonth] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!communityId) return;
    return onSnapshot(query(collection(db, "communities", communityId, SETTLEMENTS_COLLECTION)), (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })));
    });
  }, [communityId]);

  const groups = useMemo(() => items.reduce((acc: Record<string, Settlement[]>, item) => {
    const key = String(item.archiveMonth || item.period || "bez-daty");
    (acc[key] ||= []).push(item);
    return acc;
  }, {}), [items]);

  const orderedMonths = useMemo(() => Object.keys(groups).sort((a, b) => b.localeCompare(a)), [groups]);

  useEffect(() => {
    if (!orderedMonths.length) {
      setSelectedMonth("");
      return;
    }
    if (!selectedMonth || !groups[selectedMonth]) setSelectedMonth(orderedMonths[0]);
  }, [orderedMonths, groups, selectedMonth]);

  const clearMonth = async (month: string) => {
    if (!communityId) return;
    const rows = groups[month] || [];
    if (!rows.length) return;
    if (!window.confirm(`Usunąć archiwum rozliczeń za ${monthLabel(month)}?`)) return;
    setBusyMonth(month);
    setMessage(null);
    try {
      let batch = writeBatch(db);
      let ops = 0;
      let deleted = 0;
      for (const row of rows) {
        batch.delete(doc(db, "communities", communityId, SETTLEMENTS_COLLECTION, row.id));
        ops += 1;
        deleted += 1;
        if (ops >= 400) {
          await batch.commit();
          batch = writeBatch(db);
          ops = 0;
        }
      }
      if (ops > 0) await batch.commit();
      setMessage(`Usunięto ${deleted} rozliczeń za ${monthLabel(month)}.`);
    } catch (error: any) {
      setMessage(error?.message || "Błąd czyszczenia archiwum.");
    } finally {
      setBusyMonth("");
    }
  };

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0 }}>Archiwum rozliczeń</h1>
            <div style={{ opacity: 0.75 }}>Miesięczna lista wysłanych rozliczeń.</div>
          </div>
          <Link href="/charges" className="btnGhost" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Wróć do rozliczeń</Link>
        </div>

        {message ? <div style={{ color: "#8ef0c8" }}>{message}</div> : null}

        {orderedMonths.length === 0 ? <div className="card">Brak archiwum rozliczeń.</div> : (
          <>
            <div className="card" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              {orderedMonths.map((month) => (
                <button key={month} type="button" className={selectedMonth === month ? "btn" : "btnGhost"} onClick={() => setSelectedMonth(month)}>
                  {monthLabel(month)} ({groups[month]?.length || 0})
                </button>
              ))}
            </div>

            {selectedMonth && groups[selectedMonth] ? (
              <div className="card" style={{ display: "grid", gap: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <strong>{monthLabel(selectedMonth)}</strong>
                  <button className="btnGhost" onClick={() => clearMonth(selectedMonth)} disabled={busyMonth === selectedMonth}>
                    {busyMonth === selectedMonth ? "Czyszczenie..." : "Wyczyść miesiąc"}
                  </button>
                </div>
                <div style={{ display: "grid", gap: 10 }}>
                  {groups[selectedMonth].map((s) => (
                    <div key={s.id} className="card" style={{ display: "grid", gap: 10 }}>
                      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                        <b>{s.flatLabel || s.addressLabel || s.flatId}</b>
                        <span style={{ opacity: 0.75 }}>{s.period}</span>
                        <span style={{ opacity: 0.75 }}>Status: WYSŁANE</span>
                        <span style={{ opacity: 0.75 }}>Saldo: {moneyCents(s.balanceCents)}</span>
                        <span style={{ opacity: 0.75 }}>Opłaty: {moneyCents(s.chargesCents ?? s.totalChargesCents ?? s.totalCents)}</span>
                        <span style={{ opacity: 0.75 }}>Wpłaty: {moneyCents(s.paymentsCents ?? s.totalPaymentsCents)}</span>
                      </div>
                      <div style={{ opacity: 0.8 }}>Termin płatności: {s.dueDate || "—"}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </RequireAuth>
  );
}
