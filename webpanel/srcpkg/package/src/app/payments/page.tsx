"use client";

import { useEffect, useState } from "react";
import * as XLSX from "xlsx";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { callable } from "../../lib/functions";

type Payment = any;

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

export default function PaymentsPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<Payment[]>([]);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!communityId) return;
    const q = query(collection(db, "communities", communityId, "payments"), orderBy("createdAtMs", "desc"));
    return onSnapshot(q, (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
  }, [communityId]);

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Import przelewów</h2>
        <div className="card" style={{ display: "grid", gap: 12 }}>
          <p>System dopasowuje przelewy po kodzie <code>EL-xxx</code>. Nierozpoznane przelewy trafiają do reviewQueue.</p>
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={async (e) => {
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
            }}
          />
          {msg ? <div style={{ color: "green" }}>{msg}</div> : null}
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          {items.slice(0, 200).map((p) => (
            <div key={p.id} className="card" style={{ display: "flex", gap: 12 }}>
              <strong>{p.flatId || "brak dopasowania"}</strong>
              <span>{p.period || "—"}</span>
              <span>{p.title || p.source || "Wpłata"}</span>
              <span>{(Number(p.amountCents || 0) / 100).toFixed(2)} PLN</span>
              <span>{p.code || "—"}</span>
            </div>
          ))}
        </div>
      </div>
    </RequireAuth>
  );
}
