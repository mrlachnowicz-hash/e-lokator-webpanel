"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { collection, getDocs } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { normalizeStreetId } from "../../lib/streetUtils";

type Row = {
  street?: string;
  buildingNo?: string;
  apartmentNo?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  email?: string;
  phone?: string;
  areaM2?: number;
};

type Street = { id: string; name: string };

type ImportResult = {
  ok?: boolean;
  created?: number;
  updated?: number;
  skipped?: number;
  invalid?: number;
  duplicateInFile?: number;
  details?: string[];
};

function pick(raw: any, keys: string[]) {
  for (const key of keys) {
    const direct = raw?.[key];
    if (direct != null && String(direct).trim() !== "") return direct;
    const match = Object.keys(raw || {}).find((k) => k.toLowerCase() === key.toLowerCase());
    if (match) {
      const v = raw?.[match];
      if (v != null && String(v).trim() !== "") return v;
    }
  }
  return "";
}

function normalizeRow(r: any): Row {
  const apartmentNo = String(pick(r, ["apartmentNo", "flatNumber", "flatnumber", "nr", "lokal", "flat", "mieszkanie", "nr lokalu"])).trim();
  const firstName = String(pick(r, ["firstName", "name", "imie", "imię"])).trim();
  const lastName = String(pick(r, ["lastName", "surname", "nazwisko"])).trim();
  const displayName = String(pick(r, ["displayName", "residentName", "mieszkaniec"])).trim();
  const areaRaw = pick(r, ["areaM2", "metraz", "metraż", "m2", "area"]);
  return {
    street: String(pick(r, ["street", "ulica"])).trim(),
    buildingNo: String(pick(r, ["buildingNo", "nr budynku", "building", "budynek"])).trim(),
    apartmentNo,
    firstName,
    lastName,
    displayName,
    email: String(pick(r, ["email", "mail"])).trim(),
    phone: String(pick(r, ["phone", "telefon", "tel"])).trim(),
    areaM2: areaRaw !== "" ? Number(areaRaw) : undefined,
  };
}

async function readSheetFile(file: File) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".csv")) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const utf8 = new TextDecoder("utf-8").decode(bytes);
    const fallback1250 = new TextDecoder("windows-1250").decode(bytes);
    const csvText = utf8.includes("�") && !fallback1250.includes("�") ? fallback1250 : utf8;
    const wb = XLSX.read(csvText, { type: "string" });
    const ws = wb.Sheets[wb.SheetNames[0]!];
    return XLSX.utils.sheet_to_json(ws, { defval: "" }) as any[];
  }
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]!];
  return XLSX.utils.sheet_to_json(ws, { defval: "" }) as any[];
}

export default function ImportPage() {
  const { user, profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [streets, setStreets] = useState<Street[]>([]);
  const [streetId, setStreetId] = useState("");
  const [buildingNo, setBuildingNo] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [fileName, setFileName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!communityId) return;
    (async () => {
      const [streetsSnap, flatsSnap] = await Promise.all([
        getDocs(collection(db, "communities", communityId, "streets")),
        getDocs(collection(db, "communities", communityId, "flats")),
      ]);
      const byId = new Map<string, Street>();
      streetsSnap.docs.forEach((d) => {
        const data: any = d.data() || {};
        if (data.deletedAtMs) return;
        byId.set(d.id, { id: d.id, name: String(data.name || d.id) });
      });
      flatsSnap.docs.forEach((d) => {
        const data: any = d.data() || {};
        const name = String(data.street || data.streetName || "").trim();
        const id = String(data.streetId || normalizeStreetId(name) || "").trim();
        if (!id) return;
        const existing = byId.get(id);
        byId.set(id, { id, name: existing?.name || name || id });
      });
      const list = Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name, "pl"));
      setStreets(list);
      if (!streetId && list[0]) setStreetId(list[0].id);
    })();
  }, [communityId, streetId]);

  const selectedStreet = streets.find((s) => s.id === streetId)?.name || "";
  const csvHasStreet = rows.some((r) => !!r.street);
  const csvHasBuilding = rows.some((r) => !!r.buildingNo);
  const preview = useMemo(() => rows.slice(0, 8), [rows]);
  const canRun = !!user && !!communityId && rows.length > 0 && (csvHasStreet || !!streetId) && (csvHasBuilding || !!buildingNo.trim());

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16, maxWidth: 1100 }}>
        <h2>Import lokali</h2>
        <p style={{ opacity: 0.75 }}>
          CSV/XLSX może zawierać pełne dane: street, buildingNo, apartmentNo, firstName, lastName, displayName, email, phone, areaM2.
          Jeśli w pliku nie ma ulicy albo numeru budynku, panel użyje wartości wybranych ręcznie poniżej.
        </p>
        <div className="formRow" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <select className="select" value={streetId} onChange={(e) => setStreetId(e.target.value)}>
            <option value="">Wybierz ulicę</option>
            {streets.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <input className="input" placeholder="Nr budynku" value={buildingNo} onChange={(e) => setBuildingNo(e.target.value)} />
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setMsg(null);
              setErr(null);
              setDetails([]);
              setFileName(file.name);
              const json = await readSheetFile(file);
              setRows((json as any[]).map(normalizeRow).filter((r) => !!r.apartmentNo));
            }}
          />
        </div>

        {fileName ? <div style={{ opacity: 0.8, fontSize: 14 }}>Plik: <strong>{fileName}</strong>. CSV ma własną ulicę: <strong>{csvHasStreet ? "tak" : "nie"}</strong>, własny numer budynku: <strong>{csvHasBuilding ? "tak" : "nie"}</strong>.</div> : null}

        {preview.length > 0 && (
          <div className="card">
            <h3>Podgląd</h3>
            <div style={{ display: "grid", gap: 8 }}>
              {preview.map((r, idx) => {
                const lineStreet = r.street || selectedStreet || "[brak ulicy]";
                const lineBuilding = r.buildingNo || buildingNo || "[brak budynku]";
                const resident = [r.firstName, r.lastName].filter(Boolean).join(" ") || r.displayName || "brak danych";
                return <div key={idx}>{lineStreet} {lineBuilding}/{r.apartmentNo} — {resident} — {r.email || "brak email"}</div>;
              })}
            </div>
          </div>
        )}

        <div className="card">
          <div className="formRow">
            <strong>Wierszy: {rows.length}</strong>
            <button
              className="btn"
              disabled={busy || !canRun}
              onClick={async () => {
                setMsg(null); setErr(null); setDetails([]); setBusy(true);
                try {
                  const idToken = await user!.getIdToken();
                  const response = await fetch("/api/import-flats", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
                    body: JSON.stringify({ communityId, fallbackStreetId: streetId || null, fallbackStreetName: selectedStreet || null, fallbackBuildingNo: buildingNo.trim() || null, rows }),
                  });
                  const data: ImportResult = await response.json().catch(() => ({}));
                  if (!response.ok) throw new Error((data as any)?.error || "Błąd importu");
                  setMsg(`Import zakończony. Utworzono: ${data.created ?? 0}, zaktualizowano: ${data.updated ?? 0}, pominięto: ${data.skipped ?? 0}, nieprawidłowe: ${data.invalid ?? 0}, duplikaty w pliku: ${data.duplicateInFile ?? 0}.`);
                  setDetails(data.details || []);
                } catch (e: any) {
                  setErr(e?.message || "Błąd importu");
                } finally { setBusy(false); }
              }}
            >{busy ? "Importowanie..." : "Uruchom import"}</button>
          </div>
          {!canRun && rows.length > 0 ? <div style={{ color: "#d6b46b" }}>Aby uruchomić import, plik musi zawierać street/buildingNo albo musisz wybrać ulicę i wpisać numer budynku ręcznie.</div> : null}
          {msg ? <div style={{ color: "green" }}>{msg}</div> : null}
          {err ? <div style={{ color: "crimson" }}>{err}</div> : null}
          {details.length ? <div style={{ marginTop: 12, display: "grid", gap: 6, fontSize: 14, opacity: 0.9 }}>{details.slice(0, 12).map((line, index) => <div key={`${line}-${index}`}>{line}</div>)}</div> : null}
        </div>
      </div>
    </RequireAuth>
  );
}
