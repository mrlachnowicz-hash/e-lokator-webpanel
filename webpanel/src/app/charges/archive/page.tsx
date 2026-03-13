"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot, query, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/authContext";
import { Nav } from "@/components/Nav";
import { RequireAuth } from "@/components/RequireAuth";
import { SETTLEMENTS_COLLECTION } from "@/lib/settlementCollections";

type Settlement = any;

function monthLabel(period: string) {
  const names = [
    "styczeń",
    "luty",
    "marzec",
    "kwiecień",
    "maj",
    "czerwiec",
    "lipiec",
    "sierpień",
    "wrzesień",
    "październik",
    "listopad",
    "grudzień",
  ];
  const m = String(period || "").match(/^(\d{4})-(\d{2})/);
  if (!m) return period || "bez daty";
  return `${names[Number(m[2]) - 1] || m[2]} ${m[1]}`;
}

function moneyCents(v: any) {
  return `${(Number(v || 0) / 100).toFixed(2)} PLN`;
}

function monthKeyFromMs(value: unknown) {
  const ms = Number(value || 0);
  if (!(ms > 0)) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(ms));
  const year = parts.find((part) => part.type === "year")?.value || "";
  const month = parts.find((part) => part.type === "month")?.value || "";
  return year && month ? `${year}-${month}` : "";
}

function monthKeyFromText(value: unknown) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : "";
}

function archiveMonthKey(item: Settlement) {
  return (
    monthKeyFromText(item?.archiveMonth || item?.period) ||
    monthKeyFromMs(item?.publishedAtMs || item?.archivedAtMs || item?.updatedAtMs || item?.createdAtMs) ||
    "bez-daty"
  );
}

function settlementSortValue(item: Settlement) {
  return Number(item?.publishedAtMs || item?.archivedAtMs || item?.updatedAtMs || item?.createdAtMs || 0);
}

export default function ChargesArchivePage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<Settlement[]>([]);
  const [busyMonth, setBusyMonth] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [openMonths, setOpenMonths] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!communityId) return;
    return onSnapshot(query(collection(db, "communities", communityId, SETTLEMENTS_COLLECTION)), (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })));
    });
  }, [communityId]);

  const groups = useMemo(
    () =>
      items.reduce((acc: Record<string, Settlement[]>, item) => {
        const key = archiveMonthKey(item);
        (acc[key] ||= []).push(item);
        return acc;
      }, {}),
    [items]
  );

  const orderedMonths = useMemo(
    () =>
      Object.keys(groups).sort((a, b) => {
        const aMax = Math.max(...(groups[a] || []).map(settlementSortValue), 0);
        const bMax = Math.max(...(groups[b] || []).map(settlementSortValue), 0);
        if (aMax !== bMax) return bMax - aMax;
        return b.localeCompare(a);
      }),
    [groups]
  );

  useEffect(() => {
    if (!orderedMonths.length) {
      setOpenMonths({});
      return;
    }

    setOpenMonths((prev) => {
      const next: Record<string, boolean> = {};
      orderedMonths.forEach((monthKey, index) => {
        next[monthKey] = Object.prototype.hasOwnProperty.call(prev, monthKey)
          ? prev[monthKey]
          : index === 0;
      });
      return next;
    });
  }, [orderedMonths]);

  const toggleMonth = (monthKey: string) => {
    setOpenMonths((prev) => ({ ...prev, [monthKey]: !prev[monthKey] }));
  };

  const clearMonth = async (monthKey: string) => {
    if (!communityId) return;
    const rows = groups[monthKey] || [];
    if (!rows.length) return;
    if (!window.confirm(`Usunąć archiwum rozliczeń za ${monthLabel(monthKey)}?`)) return;

    setBusyMonth(monthKey);
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
      setMessage(`Usunięto ${deleted} rozliczeń za ${monthLabel(monthKey)}.`);
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
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h1 style={{ margin: 0 }}>Archiwum rozliczeń</h1>
            <div style={{ opacity: 0.75 }}>Historia wysłanych rozliczeń, pogrupowana miesiącami.</div>
          </div>
          <Link
            href="/charges"
            className="btnGhost"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
          >
            Wróć do rozliczeń
          </Link>
        </div>

        {message ? <div style={{ color: "#8ef0c8" }}>{message}</div> : null}

        {orderedMonths.length === 0 ? (
          <div className="card">Brak archiwum rozliczeń.</div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {orderedMonths.map((monthKey) => {
              const rows = [...(groups[monthKey] || [])].sort(
                (a, b) => settlementSortValue(b) - settlementSortValue(a)
              );
              const open = !!openMonths[monthKey];
              return (
                <div key={monthKey} className="card" style={{ display: "grid", gap: 12 }}>
                  <button
                    type="button"
                    className="btnGhost"
                    onClick={() => toggleMonth(monthKey)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <span>
                      {open ? "▾" : "▸"} {monthLabel(monthKey)}
                    </span>
                    <span>{rows.length}</span>
                  </button>

                  {open ? (
                    <>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 12,
                          alignItems: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        <strong>{monthLabel(monthKey)}</strong>
                        <button
                          className="btnGhost"
                          onClick={() => clearMonth(monthKey)}
                          disabled={busyMonth === monthKey}
                        >
                          {busyMonth === monthKey ? "Czyszczenie..." : "Wyczyść miesiąc"}
                        </button>
                      </div>

                      <div style={{ display: "grid", gap: 10 }}>
                        {rows.map((s) => (
                          <div key={s.id} className="card" style={{ display: "grid", gap: 10 }}>
                            <div
                              style={{
                                display: "flex",
                                gap: 12,
                                alignItems: "center",
                                flexWrap: "wrap",
                              }}
                            >
                              <b>{s.flatLabel || s.addressLabel || s.flatId}</b>
                              <span style={{ opacity: 0.75 }}>{s.period}</span>
                              <span style={{ opacity: 0.75 }}>Status: WYSŁANE</span>
                              <span style={{ opacity: 0.75 }}>
                                Saldo: {moneyCents(s.balanceCents)}
                              </span>
                              <span style={{ opacity: 0.75 }}>
                                Opłaty: {moneyCents(
                                  s.chargesCents ?? s.totalChargesCents ?? s.totalCents
                                )}
                              </span>
                              <span style={{ opacity: 0.75 }}>
                                Wpłaty: {moneyCents(s.paymentsCents ?? s.totalPaymentsCents)}
                              </span>
                            </div>
                            <div style={{ opacity: 0.8 }}>Termin płatności: {s.dueDate || "—"}</div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </RequireAuth>
  );
}
