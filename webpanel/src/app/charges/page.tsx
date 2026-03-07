"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { callable } from "../../lib/functions";

type Settlement = any;

function money(v: any) {
  return `${(Number(v || 0) / 100).toFixed(2)} PLN`;
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

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Rozliczenia lokali</h2>
        <p style={{ opacity: 0.8, marginTop: -8 }}>Po utworzeniu lub aktualizacji rozliczenia lokator z aplikacją widzi bieżący miesiąc w kafelku "Rozliczenia" wraz z kwotą, terminem i danymi do przelewu.</p>
        {msg && <div style={{ color: "green" }}>{msg}</div>}

        <div style={{ display: "grid", gap: 10 }}>
          {items.slice(0, 200).map((s) => (
            <div key={s.id} className="card" style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <b>{s.flatId}</b>
                <span style={{ opacity: 0.75 }}>{s.period}</span>
                <span style={{ opacity: 0.75 }}>Saldo: {money(s.balanceCents)}</span>
                <span style={{ opacity: 0.75 }}>Opłaty: {money(s.chargesCents)}</span>
                <span style={{ opacity: 0.75 }}>Wpłaty: {money(s.paymentsCents)}</span>
              </div>
              <div style={{ display: "grid", gap: 4, opacity: 0.9 }}>
                <div>Termin płatności: {s.dueDate || "—"}</div>
                <div>Rachunek: {s.accountNumber || "—"}</div>
                <div>Tytuł przelewu: {s.transferTitle || "—"}</div>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button className="btn" onClick={async () => {
                  const res = await callable<any, any>("generateSettlementPdf")({ communityId, settlementId: s.id });
                  const url = String((res.data as any)?.pdfUrl || "");
                  if (url) window.open(url, "_blank");
                  setMsg("PDF gotowy.");
                }}>PDF</button>
                <button className="btn" onClick={async () => {
                  const res = await callable<any, any>("sendSettlementEmail")({ communityId, settlementId: s.id });
                  const data = (res.data as any) || {};
                  setMsg(`Email zakolejkowany do: ${data.email || "—"}`);
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
