"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { collection, doc, getDocs, query, where, writeBatch } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";

type Row = {
  apartmentNo?: string;
  name?: string;
  surname?: string;
  email?: string;
  phone?: string;
  areaM2?: number;
};

type Street = { id: string; name: string };

function normalizeRow(r: any): Row {
  const val = (keys: string[]) => keys.map((k) => r[k]).find((v) => v != null && String(v).trim() !== "") ?? "";
  return {
    apartmentNo: String(val(["apartmentNo", "flatNumber", "flatnumber", "nr", "lokal", "flat", "mieszkanie"])).trim(),
    name: String(val(["name", "imie", "imię"])).trim(),
    surname: String(val(["surname", "nazwisko"])).trim(),
    email: String(val(["email", "mail"])).trim(),
    phone: String(val(["phone", "telefon", "tel"])).trim(),
    areaM2: val(["areaM2", "metraz", "metraż", "m2", "area"]) ? Number(val(["areaM2", "metraz", "metraż", "m2", "area"])) : undefined,
  };
}

export default function ImportPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [streets, setStreets] = useState<Street[]>([]);
  const [street, setStreet] = useState("");
  const [buildingNo, setBuildingNo] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!communityId) return;
    (async () => {
      const snap = await getDocs(collection(db, "communities", communityId, "streets"));
      const list = snap.docs.map((d) => ({ id: d.id, name: String((d.data() as any).name || d.id) })).sort((a, b) => a.name.localeCompare(b.name, "pl"));
      setStreets(list);
      if (!street && list[0]) setStreet(list[0].name);
    })();
  }, [communityId, street]);

  const preview = useMemo(() => rows.slice(0, 8), [rows]);

  return (
    <RequireAuth roles={["MASTER", "ADMIN", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16, maxWidth: 1100 }}>
        <h2>Import lokali</h2>
        <p style={{ opacity: 0.75 }}>Źródłem prawdy jest aplikacja. Wybierz istniejącą ulicę, podaj numer budynku i zaimportuj lokale oraz payerów.</p>
        <div className="formRow" style={{ flexWrap: "wrap" }}>
          <select className="select" value={street} onChange={(e) => setStreet(e.target.value)}>
            <option value="">Wybierz ulicę</option>
            {streets.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
          </select>
          <input className="input" placeholder="Nr budynku" value={buildingNo} onChange={(e) => setBuildingNo(e.target.value)} />
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const data = await file.arrayBuffer();
              const wb = XLSX.read(data);
              const ws = wb.Sheets[wb.SheetNames[0]!];
              const json = XLSX.utils.sheet_to_json(ws, { defval: "" });
              setRows((json as any[]).map(normalizeRow).filter((r) => !!r.apartmentNo));
            }}
          />
        </div>

        {preview.length > 0 && (
          <div className="card">
            <h3>Podgląd</h3>
            <div style={{ display: "grid", gap: 8 }}>
              {preview.map((r, idx) => <div key={idx}>{r.apartmentNo} — {r.name} {r.surname} — {r.email || "brak email"}</div>)}
            </div>
          </div>
        )}

        <div className="card">
          <div className="formRow">
            <strong>Wierszy: {rows.length}</strong>
            <button
              className="btn"
              disabled={!communityId || !street || !buildingNo || rows.length === 0}
              onClick={async () => {
                setMsg(null); setErr(null);
                try {
                  const existingSnap = await getDocs(query(
                    collection(db, "communities", communityId, "flats"),
                    where("street", "==", street),
                    where("buildingNo", "==", buildingNo.trim())
                  ));
                  const existingByApartment = new Map(existingSnap.docs.map((d) => [String((d.data() as any).apartmentNo || ""), d]));
                  const batch = writeBatch(db);
                  let created = 0;
                  let updated = 0;
                  const now = Date.now();
                  const streetNorm = street.trim().toLowerCase().replace(/\s+/g, " ");
                  for (const row of rows) {
                    const apartmentNo = String(row.apartmentNo || "").trim();
                    if (!apartmentNo) continue;
                    const flatKey = `${streetNorm}|${buildingNo.trim()}|${apartmentNo}`;
                    const existing = existingByApartment.get(apartmentNo);
                    const flatRef = existing ? existing.ref : doc(collection(db, "communities", communityId, "flats"));
                    batch.set(flatRef, {
                      street: street.trim(),
                      buildingNo: buildingNo.trim(),
                      apartmentNo,
                      flatLabel: apartmentNo,
                      flatKey,
                      areaM2: row.areaM2 ?? null,
                      status: existing?.data()?.status || "EMPTY",
                      updatedAtMs: now,
                      createdAtMs: existing?.data()?.createdAtMs || now,
                    }, { merge: true });
                    const payerRef = doc(db, "communities", communityId, "payers", flatRef.id);
                    batch.set(payerRef, {
                      flatId: flatRef.id,
                      street: street.trim(),
                      buildingNo: buildingNo.trim(),
                      apartmentNo,
                      name: row.name || "",
                      surname: row.surname || "",
                      email: row.email || "",
                      phone: row.phone || "",
                      mailOnly: !!row.email,
                      updatedAtMs: now,
                      createdAtMs: existing?.data()?.createdAtMs || now,
                    }, { merge: true });
                    if (existing) updated += 1; else created += 1;
                  }
                  await batch.commit();
                  setMsg(`Import zakończony. Utworzono: ${created}, zaktualizowano: ${updated}.`);
                } catch (e: any) {
                  setErr(e?.message || "Błąd importu");
                }
              }}
            >Uruchom import</button>
          </div>
          {msg ? <div style={{ color: "#8ef58e" }}>{msg}</div> : null}
          {err ? <div style={{ color: "#ff9a9a" }}>{err}</div> : null}
        </div>
      </div>
    </RequireAuth>
  );
}
