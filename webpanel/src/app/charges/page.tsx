"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { callable } from "../../lib/functions";

type Charge = any;

export default function ChargesPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<Charge[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!communityId) return;
    const q = query(collection(db, "communities", communityId, "charges"), orderBy("createdAtMs", "desc"));
    return onSnapshot(q, (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
  }, [communityId]);

  return (
    <RequireAuth roles={["MASTER", "ADMIN", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Naliczenia (charges) – per flatId</h2>
        {msg && <div style={{ color: "green" }}>{msg}</div>}

        <div style={{ display: "grid", gap: 10 }}>
          {items.slice(0, 200).map((c) => (
            <div key={c.id} style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, display: "flex", gap: 12, alignItems: "center" }}>
              <b>{c.flatId}</b>
              <span style={{ opacity: 0.7 }}>{c.period}</span>
              <span style={{ opacity: 0.7 }}>{c.category}</span>
              <span style={{ opacity: 0.7 }}>{(Number(c.amountCents || 0) / 100).toFixed(2)} PLN</span>
              <div style={{ flex: 1 }} />
              <button
                onClick={async () => {
                  const fn = callable<any, any>("generateSettlementPdf");
                  const res = await fn({ communityId, flatId: c.flatId, period: c.period });
                  const b64 = (res.data as any).base64 as string;
                  const blob = await (await fetch(`data:application/pdf;base64,${b64}`)).blob();
                  const url = URL.createObjectURL(blob);
                  window.open(url, "_blank");
                }}
              >
                PDF
              </button>
              <button
                onClick={async () => {
                  const fn = callable<any, any>("sendSettlementEmail");
                  const res = await fn({ communityId, flatId: c.flatId, period: c.period });
                  setMsg(`Email: ${(res.data as any).mode}`);
                }}
              >
                Wyślij email (MVP)
              </button>
            </div>
          ))}
        </div>
        <div style={{ opacity: 0.65 }}>Podgląd: max 200 ostatnich naliczeń.</div>
      </div>
    </RequireAuth>
  );
}
