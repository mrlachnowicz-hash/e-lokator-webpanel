"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { addDoc, collection, doc, getDocs, query, setDoc, where, writeBatch } from "firebase/firestore";
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

type Building = { id: string; label: string };

function normalizeRow(r: any): Row {
  const val = (keys: string[]) => keys.map((k) => r[k]).find((v) => v != null && String(v).trim() !== "") ?? "";
  return {
    flatNumber: String(val(["flatNumber", "flatnumber", "nr", "lokal", "flat", "mieszkanie"])).trim(),
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
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [buildingId, setBuildingId] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!communityId) return;
    (async () => {
      const snap = await getDocs(collection(db, "communities", communityId, "buildings"));
      const list = snap.docs.map((d) => ({ id: d.id, label: String(d.data().label || d.data().name || d.id) }));
      setBuildings(list);
      if (!buildingId && list[0]) setBuildingId(list[0].id);
    })();
  }, [communityId, buildingId]);

  const preview = useMemo(() => rows.slice(0, 8), [rows]);

  return (
    <RequireAuth roles={["MASTER", "ADMIN", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16, maxWidth: 1100 }}>
        <h2>Import lokali</h2>
        <p style={{ opacity: 0.75 }}>Webpanel nie tworzy ulic ani budynków. Wybierz istniejący budynek z aplikacji i zaimportuj lokale oraz payerów.</p>
        <div className="formRow">
          <select className="select" value={buildingId} onChange={(e) => setBuildingId(e.target.value)}>
            <option value="">Wybierz budynek</option>
            {buildings.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
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
              {preview.map((r, idx) => <div key={idx}>{r.flatNumber} — {r.name} {r.surname} — {r.email || "brak email"}</div>)}
            </div>
          </div>
        )}

        <div className="card">
          <div className="formRow">
            <strong>Wierszy: {rows.length}</strong>
            <button
              className="btn"
              disabled={!communityId || !buildingId || rows.length === 0}
              onClick={async () => {
                setMsg(null); setErr(null);
                try {
                  const existingSnap = await getDocs(query(collection(db, "communities", communityId, "flats"), where("buildingId", "==", buildingId)));
                  const existingByFlat = new Map(existingSnap.docs.map((d) => [String(d.data().flatNumber || ""), d]));
                  const batch = writeBatch(db);
                  let created = 0;
                  let updated = 0;
                  for (const row of rows) {
                    const flatNumber = String(row.flatNumber || "").trim();
                    if (!flatNumber) continue;
                    const existing = existingByFlat.get(flatNumber);
                    const flatRef = existing ? doc(db, "communities", communityId, "flats", existing.id) : doc(collection(db, "communities", communityId, "flats"));
                    batch.set(flatRef, {
                      buildingId,
                      flatNumber,
                      name: row.name || "",
                      surname: row.surname || "",
                      email: row.email || "",
                      phone: row.phone || "",
                      areaM2: row.areaM2 ?? null,
                      updatedAtMs: Date.now(),
                      createdAtMs: existing?.data()?.createdAtMs || Date.now(),
                    }, { merge: true });
                    const payerRef = existing ? doc(db, "communities", communityId, "payers", existing.id) : doc(db, "communities", communityId, "payers", flatRef.id);
                    batch.set(payerRef, {
                      flatId: flatRef.id,
                      buildingId,
                      flatNumber,
                      name: row.name || "",
                      surname: row.surname || "",
                      email: row.email || "",
                      phone: row.phone || "",
                      mailOnly: !!row.email,
                      updatedAtMs: Date.now(),
                      createdAtMs: existing?.data()?.createdAtMs || Date.now(),
                    }, { merge: true });
                    if (existing) updated += 1; else created += 1;
                  }
                  await batch.commit();
                  await addDoc(collection(db, "communities", communityId, "auditLogs"), {
                    type: "IMPORT_FLATS",
                    buildingId,
                    rows: rows.length,
                    created,
                    updated,
                    createdAtMs: Date.now(),
                  });
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
