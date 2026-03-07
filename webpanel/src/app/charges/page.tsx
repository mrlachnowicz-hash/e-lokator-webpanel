"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";

type Settlement = any;

function money(v: any) {
  return `${Number(v || 0).toFixed(2)} PLN`;
}

function centsOrAmount(cents: any, amount: any) {
  if (cents != null) return Number(cents) / 100;
  return Number(amount || 0);
}

export default function ChargesPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<Settlement[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!communityId) return;
    const q = query(collection(db, "communities", communityId, "settlements"), orderBy("updatedAtMs", "desc"));
    return onSnapshot(q, (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
  }, [communityId]);

  const stats = useMemo(() => ({
    drafts: items.filter((s) => s.isPublished !== true).length,
    published: items.filter((s) => s.isPublished === true).length,
  }), [items]);

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Rozliczenia lokali</h2>
        <p style={{ opacity: 0.8, marginTop: -8 }}>Workflow: najpierw naliczasz faktury do szkicu, potem wchodzisz tutaj, sprawdzasz rozliczenia i dopiero kliknięciem „Wyślij do lokatora” publikujesz je w aplikacji. Samo naliczenie nie pokazuje jeszcze rozliczenia lokatorowi.</p>
        <div className="card" style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
          <div>Szkice: <strong>{stats.drafts}</strong></div>
          <div>Wysłane: <strong>{stats.published}</strong></div>
          <button className="btn" onClick={async () => {
            const res = await fetch("/api/settlements/publish-all-drafts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ communityId }),
            });
            const data = await res.json();
            setMsg(res.ok ? `Wysłano do lokatorów: ${data.published || 0} rozliczeń.` : `Błąd: ${data.error || "nieznany"}`);
          }}>Wyślij wszystkie szkice</button>
        </div>
        {msg && <div style={{ color: "green" }}>{msg}</div>}

        <div style={{ display: "grid", gap: 10 }}>
          {items.slice(0, 200).map((s) => (
            <div key={s.id} className="card" style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <b>{s.flatLabel || s.addressLabel || s.flatId}</b>
                <span style={{ opacity: 0.75 }}>{s.period}</span>
                <span style={{ opacity: 0.75 }}>Status: {s.isPublished ? "WYSŁANE" : "SZKIC"}</span>
                <span style={{ opacity: 0.75 }}>Saldo: {money(centsOrAmount(s.balanceCents, s.balance))}</span>
                <span style={{ opacity: 0.75 }}>Opłaty: {money(centsOrAmount(s.chargesCents ?? s.totalCents, s.total))}</span>
                <span style={{ opacity: 0.75 }}>Wpłaty: {money(centsOrAmount(s.paymentsCents, s.payments))}</span>
              </div>
              <div style={{ display: "grid", gap: 4, opacity: 0.9 }}>
                <div>Termin płatności: {s.dueDate || "—"}</div>
                <div>Rachunek: {s.accountNumber || "—"}</div>
                <div>Tytuł przelewu: {s.transferTitle || "—"}</div>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Link href={`/settlements/${s.id}`} className="btn" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                  Otwórz podgląd
                </Link>
                {!s.isPublished ? (
                  <button className="btn" onClick={async () => {
                    const res = await fetch(`/api/settlements/publish`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ communityId, settlementId: s.id }),
                    });
                    const data = await res.json();
                    setMsg(res.ok ? `Rozliczenie ${data.settlementId} wysłane do lokatora.` : `Błąd publikacji: ${data.error || "nieznany"}`);
                  }}>Wyślij do lokatora</button>
                ) : null}
                <button className="btnGhost" onClick={async () => {
                  const url = `/api/settlements/${s.id}/pdf?communityId=${encodeURIComponent(communityId)}`;
                  window.open(url, "_blank");
                  setMsg("PDF gotowy.");
                }}>PDF</button>
                <button className="btnGhost" onClick={async () => {
                  const res = await fetch(`/api/settlements/${s.id}/send-email`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ communityId }),
                  });
                  const data = await res.json();
                  setMsg(res.ok ? `Email wysłany do: ${data.email || "—"}` : `Błąd email: ${data.error || "nieznany"}`);
                }}>Wyślij email</button>
              </div>
            </div>
          ))}
        </div>
        <div style={{ opacity: 0.65 }}>Podgląd: max 200 ostatnich rozliczeń.</div>
      </div>
    </RequireAuth>
  );
}
