"use client";

import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { writeBatch, collection, doc } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";

type Row = {
  building?: string;
  flatNumber?: string;
  name?: string;
  surname?: string;
  email?: string;
  phone?: string;
  areaM2?: number;
};

function normalizeRow(r: any): Row {
  const building = String(r.building ?? r.BUILDING ?? r.budynek ?? "").trim();
  const flatNumber = String(r.flatNumber ?? r.flatnumber ?? r.nr ?? r.flat ?? r.lokal ?? r.flatno ?? "").trim();
  const name = String(r.name ?? r.imie ?? "").trim();
  const surname = String(r.surname ?? r.nazwisko ?? "").trim();
  const email = String(r.email ?? "").trim();
  const phone = String(r.phone ?? r.tel ?? r.telefon ?? "").trim();
  const areaM2 = r.areaM2 ?? r.area ?? r.metraz ?? r.m2;
  return { building, flatNumber, name, surname, email, phone, areaM2: areaM2 ? Number(areaM2) : undefined };
}

export default function ImportPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const role = String(profile?.role || "");
  const canImport = useMemo(() => ["MASTER", "ADMIN", "ACCOUNTANT"].includes(role), [role]);

  const [rows, setRows] = useState<Row[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  return (
    <RequireAuth roles={["MASTER", "ADMIN", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16, maxWidth: 1000 }}>
        <h2>Import lokali (CSV / XLSX)</h2>
        <p style={{ opacity: 0.75 }}>
          Minimalne kolumny: <code>building</code>, <code>flatNumber</code>, <code>name</code>, <code>surname</code>, <code>email</code>, <code>phone</code>.
        </p>

        <input
          type="file"
          accept=".csv,.xlsx,.xls"
          onChange={async (e) => {
            setMsg(null);
            setErr(null);
            const file = e.target.files?.[0];
            if (!file) return;
            const data = await file.arrayBuffer();
            const wb = XLSX.read(data);
            const ws = wb.Sheets[wb.SheetNames[0]!];
            const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
            const parsed = (json as any[]).map(normalizeRow).filter(r => !!r.flatNumber);
            setRows(parsed);
          }}
        />

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <b>Wierszy:</b> {rows.length}
            <div style={{ flex: 1 }} />
            {canImport && (
              <button
                onClick={async () => {
                  setMsg(null);
                  setErr(null);
                  try {
                    if (!communityId) throw new Error("Brak communityId");
                    if (rows.length === 0) throw new Error("Brak danych");

                    // Firestore batch limit 500
                    const chunks: Row[][] = [];
                    for (let i = 0; i < rows.length; i += 400) chunks.push(rows.slice(i, i + 400));

                    let created = 0;
                    for (const chunk of chunks) {
                      const batch = writeBatch(db);
                      for (const r of chunk) {
                        const ref = doc(collection(db, "communities", communityId, "flats"));
                        batch.set(ref, {
                          building: r.building || "",
                          flatNumber: r.flatNumber || "",
                          name: r.name || "",
                          surname: r.surname || "",
                          email: r.email || "",
                          phone: r.phone || "",
                          areaM2: r.areaM2 ?? null,
                          createdAtMs: Date.now(),
                          seatUsed: true,
                          payer: {
                            name: r.name || "",
                            surname: r.surname || "",
                            email: r.email || "",
                            phone: r.phone || "",
                            uid: null,
                            mode: r.email ? "MAIL" : "OFFLINE"
                          }
                        });
                        created++;
                      }
                      await batch.commit();
                    }
                    setMsg(`Import OK: utworzono ${created} lokali.`);
                  } catch (e: any) {
                    setErr(e?.message || "Błąd importu");
                  }
                }}
              >
                Importuj do Firestore
              </button>
            )}
          </div>
          {msg && <div style={{ color: "green", marginTop: 10 }}>{msg}</div>}
          {err && <div style={{ color: "crimson", marginTop: 10 }}>{err}</div>}
        </div>

        <div style={{ maxHeight: 360, overflow: "auto", border: "1px solid #eee", borderRadius: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>building</th>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>flatNumber</th>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>name</th>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>surname</th>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>email</th>
                <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>phone</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((r, idx) => (
                <tr key={idx}>
                  <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{r.building}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{r.flatNumber}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{r.name}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{r.surname}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{r.email}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{r.phone}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ opacity: 0.65 }}>
          Podgląd pokazuje max 200 wierszy.
        </div>
      </div>
    </RequireAuth>
  );
}
