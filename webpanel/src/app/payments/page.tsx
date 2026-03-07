"use client";

import { useEffect, useState } from "react";
import * as XLSX from "xlsx";
import { collection, getDocs, onSnapshot, orderBy, query } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { buildFlatLabel } from "../../lib/flatMapping";
import { callable } from "../../lib/functions";

type Payment = any;

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

export default function PaymentsPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<Payment[]>([]);
  const [msg, setMsg] = useState("");
  const [flatLabels, setFlatLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!communityId) return;
    const q = query(collection(db, "communities", communityId, "payments"), orderBy("createdAtMs", "desc"));
    return onSnapshot(q, async (snap) => {
      const data = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
      setItems(data);
      const flatSnap = await getDocs(collection(db, "communities", communityId, "flats"));
      const labelMap: Record<string, string> = {};
      flatSnap.docs.forEach((docSnap) => {
        const flat: any = docSnap.data() || {};
        labelMap[docSnap.id] = String(flat.flatLabel || buildFlatLabel(flat.street, flat.buildingNo, flat.apartmentNo) || docSnap.id);
      });
      setFlatLabels(labelMap);
    });
  }, [communityId]);

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Import przelewów</h2>
        <p style={{ opacity: 0.8, marginTop: -8 }}>Kolejność dopasowania: 1) tytuł przelewu, 2) numer lokalu, 3) nazwisko, 4) adres, 5) kwota równa sumie rozliczenia. Nierozpoznane wpłaty trafiają do reviewQueue.</p>
        <div className="card" style={{ display: "grid", gap: 12 }}>
          <p>System dopasowuje przelewy najpierw po kodzie <code>EL-xxx</code>, a gdy go brakuje lub jest błędny, próbuje dopasować wpłatę po numerze lokalu, nazwisku, adresie i treści przelewu. Dopiero nierozpoznane wpłaty trafiają do reviewQueue.</p>
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
              <strong>{flatLabels[String(p.flatId || "")] || p.flatLabel || p.flatId || "brak dopasowania"}</strong>
              <span>{p.period || "—"}</span>
              <span>{p.title || p.source || "Wpłata"}</span>
              <span>{(Number(p.amountCents || 0) / 100).toFixed(2)} PLN</span>
              <span>{p.code || "—"}</span>
              <span>{paymentStatusLabel(p)}</span>
            </div>
          ))}
        </div>
      </div>
    </RequireAuth>
  );
}
