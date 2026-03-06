"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { collection, doc, getDocs, writeBatch } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";

type Row = {
  flatNumber?: string;
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
    flatNumber: String(val(["flatNumber", "flatnumber", "nr", "lokal", "flat", "mieszkanie", "apartmentNo"])).trim(),
    name: String(val(["name", "imie", "imię"])).trim(),
    surname: String(val(["surname", "nazwisko"])).trim(),
    email: String(val(["email", "mail"])).trim(),
    phone: String(val(["phone", "telefon", "tel"])).trim(),
    areaM2: val(["areaM2", "metraz", "metraż", "m2", "area"]) ? Number(val(["areaM2", "metraz", "metraż", "m2", "area"])) : undefined,
  };
}

function normalizePart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9_-]/g, "");
}

function buildFlatKey(communityId: string, street: string, buildingNo: string, apartmentNo: string) {
  return [communityId, street, buildingNo, apartmentNo].map(normalizePart).filter(Boolean).join("|");
}

export default function ImportPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [streets, setStreets] = useState<Street[]>([]);
  const [streetId, setStreetId] = useState("");
  const [buildingNo, setBuildingNo] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!communityId) return;
    (async () => {
      const snap = await getDocs(collection(db, "communities", communityId, "streets"));
      const list = snap.docs.map((d) => ({ id: d.id, name: String((d.data() as any).name || d.id) }));
      setStreets(list);
      if (!streetId && list[0]) setStreetId(list[0].id);
    })();
  }, [communityId, streetId]);

  const preview = useMemo(() => rows.slice(0, 8), [rows]);
  const selectedStreet = streets.find((s) => s.id === streetId)?.name || "";

  return (
    <RequireAuth roles={["MASTER", "ADMIN", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16, maxWidth: 1100 }}>
        <h2>Import lokali</h2>
        <p style={{ opacity: 0.75 }}>Aplikacja jest źródłem prawdy. Wybierz istniejącą ulicę z aplikacji, wpisz numer budynku i zaimportuj lokale bez tworzenia duplikatów.</p>
        <div className="formRow" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <select className="select" value={streetId} onChange={(e) => setStreetId(e.target.value)}>
            <option value="">Wybierz ulicę</option>
            {streets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
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
              setRows((json as any[]).map(normalizeRow).filter((r) => !!r.flatNumber));
            }}
          />
        </div>

        {preview.length > 0 && (
          <div className="card">
            <h3>Podgląd</h3>
            <div style={{ display: "grid", gap: 8 }}>
              {preview.map((r, idx) => <div key={idx}>{selectedStreet} {buildingNo}/{r.flatNumber} — {r.name} {r.surname} — {r.email || "brak email"}</div>)}
            </div>
          </div>
        )}

        <div className="card">
          <div className="formRow">
            <strong>Wierszy: {rows.length}</strong>
            <button
              className="btn"
              disabled={!communityId || !streetId || !buildingNo.trim() || rows.length === 0}
              onClick={async () => {
                setMsg(null); setErr(null);
                try {
                  const allFlats = await getDocs(collection(db, "communities", communityId, "flats"));
                  const existingByKey = new Map<string, any>();
                  allFlats.docs.forEach((d) => {
                    const x: any = d.data();
                    const key = String(x.flatKey || buildFlatKey(communityId, String(x.street || ""), String(x.buildingNo || ""), String(x.apartmentNo || x.flatNumber || "")));
                    existingByKey.set(key, d);
                  });
                  const batch = writeBatch(db);
                  let created = 0;
                  let updated = 0;
                  for (const row of rows) {
                    const apartmentNo = String(row.flatNumber || "").trim();
                    if (!apartmentNo) continue;
                    const flatKey = buildFlatKey(communityId, selectedStreet, buildingNo, apartmentNo);
                    const existing = existingByKey.get(flatKey);
                    const flatRef = existing ? doc(db, "communities", communityId, "flats", existing.id) : doc(collection(db, "communities", communityId, "flats"));
                    const createdAtMs = existing?.data()?.createdAtMs || Date.now();
                    batch.set(flatRef, {
                      communityId,
                      streetId,
                      street: selectedStreet,
                      buildingNo: buildingNo.trim(),
                      apartmentNo,
                      flatNumber: apartmentNo,
                      flatLabel: `${selectedStreet} ${buildingNo.trim()}/${apartmentNo}`,
                      flatKey,
                      name: row.name || existing?.data()?.name || "",
                      surname: row.surname || existing?.data()?.surname || "",
                      email: row.email || existing?.data()?.email || "",
                      phone: row.phone || existing?.data()?.phone || "",
                      areaM2: row.areaM2 ?? existing?.data()?.areaM2 ?? null,
                      updatedAtMs: Date.now(),
                      createdAtMs,
                    }, { merge: true });
                    const payerRef = doc(db, "communities", communityId, "payers", flatRef.id);
                    batch.set(payerRef, {
                      flatId: flatRef.id,
                      streetId,
                      street: selectedStreet,
                      buildingNo: buildingNo.trim(),
                      apartmentNo,
                      flatLabel: `${selectedStreet} ${buildingNo.trim()}/${apartmentNo}`,
                      flatKey,
                      name: row.name || "",
                      surname: row.surname || "",
                      email: row.email || "",
                      phone: row.phone || "",
                      mailOnly: !!row.email,
                      updatedAtMs: Date.now(),
                      createdAtMs,
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
          {msg ? <div style={{ color: "green" }}>{msg}</div> : null}
          {err ? <div style={{ color: "crimson" }}>{err}</div> : null}
        </div>
      </div>
    </RequireAuth>
  );
}
