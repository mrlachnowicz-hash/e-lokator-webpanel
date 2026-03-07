"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { addDoc, collection, doc, getDocs, onSnapshot, orderBy, query, setDoc, writeBatch } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { buildFlatKey, buildFlatLabel, normalizeApartmentNo, normalizePart } from "../../lib/flatMapping";

type Flat = {
  id: string;
  street?: string;
  buildingNo?: string;
  apartmentNo?: string;
  flatLabel?: string;
};

type Meter = {
  id: string;
  communityId?: string;
  flatId?: string;
  street?: string;
  buildingNo?: string;
  apartmentNo?: string;
  type?: string;
  serialNumber?: string;
  unit?: string;
  isActive?: boolean;
  createdAtMs?: number;
  updatedAtMs?: number;
};

type Reading = {
  id: string;
  meterId?: string;
  flatId?: string;
  value?: number;
  date?: string;
  source?: string;
  consumption?: number;
  chargeAmount?: number;
  chargeAmountCents?: number;
  period?: string;
};

type ImportRow = {
  street?: string;
  buildingNo?: string;
  apartmentNo?: string;
  meterType?: string;
  value?: number;
  date?: string;
};

function normalizeMeterType(value: unknown) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw.includes("wod")) return "water";
  if (raw.includes("ciep") || raw.includes("heat")) return "heat";
  if (raw.includes("gaz")) return "gas";
  if (raw.includes("prad") || raw.includes("prąd") || raw.includes("energy")) return "electricity";
  return raw || "other";
}

function normalizeImportRow(row: any): ImportRow {
  const pick = (...keys: string[]) => keys.map((k) => row[k]).find((value) => value != null && String(value).trim() !== "") ?? "";
  const value = Number(String(pick("value", "odczyt", "stan")).replace(",", "."));
  return {
    street: String(pick("street", "ulica")).trim(),
    buildingNo: String(pick("buildingNo", "budynek", "nrBudynku")).trim(),
    apartmentNo: String(pick("apartmentNo", "flatNumber", "flatNo", "lokal", "nrLokalu")).trim(),
    meterType: normalizeMeterType(pick("meterType", "type", "rodzaj", "licznik")),
    value: Number.isFinite(value) ? value : undefined,
    date: String(pick("date", "data")).trim(),
  };
}

export default function MetersPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [flats, setFlats] = useState<Flat[]>([]);
  const [meters, setMeters] = useState<Meter[]>([]);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({
    flatId: "",
    street: "",
    buildingNo: "",
    apartmentNo: "",
    type: "water",
    serialNumber: "",
    unit: "m3",
  });

  useEffect(() => {
    if (!communityId) return;
    const unsubFlats = onSnapshot(collection(db, "communities", communityId, "flats"), (snap) => setFlats(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
    const unsubMeters = onSnapshot(query(collection(db, "communities", communityId, "meters"), orderBy("updatedAtMs", "desc")), (snap) => setMeters(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
    const unsubReadings = onSnapshot(query(collection(db, "communities", communityId, "meterReadings"), orderBy("createdAtMs", "desc")), (snap) => setReadings(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
    return () => {
      unsubFlats();
      unsubMeters();
      unsubReadings();
    };
  }, [communityId]);

  const flatOptions = useMemo(() => flats.map((flat) => ({
    ...flat,
    label: flat.flatLabel || buildFlatLabel(flat.street, flat.buildingNo, flat.apartmentNo),
    flatKey: buildFlatKey(communityId, flat.street, flat.buildingNo, flat.apartmentNo),
  })), [communityId, flats]);

  const tariffByType: Record<string, number> = {
    water: 12,
    heat: 18,
    gas: 4,
    electricity: 1.2,
    other: 1,
  };

  async function saveMeter() {
    if (!communityId) return;
    const selectedFlat = flatOptions.find((flat) => flat.id === form.flatId);
    const street = form.street || selectedFlat?.street || "";
    const buildingNo = form.buildingNo || selectedFlat?.buildingNo || "";
    const apartmentNo = form.apartmentNo || selectedFlat?.apartmentNo || "";
    const flatId = form.flatId || selectedFlat?.id || "";
    if (!flatId || !street || !buildingNo || !apartmentNo) return;

    await addDoc(collection(db, "communities", communityId, "meters"), {
      id: undefined,
      communityId,
      flatId,
      street,
      buildingNo,
      apartmentNo,
      type: form.type,
      serialNumber: form.serialNumber.trim(),
      unit: form.unit.trim() || "m3",
      isActive: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });

    setForm({ flatId: "", street: "", buildingNo: "", apartmentNo: "", type: "water", serialNumber: "", unit: "m3" });
    setMessage("Dodano licznik.");
  }

  async function importReadings(file: File) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf);
    const ws = wb.Sheets[wb.SheetNames[0]!];
    const rows = (XLSX.utils.sheet_to_json(ws, { defval: "" }) as any[]).map(normalizeImportRow);

    const flatsByKey = new Map(flatOptions.map((flat) => [buildFlatKey(communityId, flat.street, flat.buildingNo, flat.apartmentNo), flat]));
    const activeMeters = meters.filter((meter) => meter.isActive !== false);
    const readingsSnap = await getDocs(collection(db, "communities", communityId, "meterReadings"));
    const allReadings = readingsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as Reading[];
    const batch = writeBatch(db);

    let imported = 0;
    let generatedCharges = 0;
    let skipped = 0;

    for (const row of rows) {
      const street = row.street || "";
      const buildingNo = row.buildingNo || "";
      const apartmentNo = normalizeApartmentNo(row.apartmentNo);
      const key = buildFlatKey(communityId, street, buildingNo, apartmentNo);
      const flat = flatsByKey.get(key)
        || flatOptions.find((item) => normalizePart(item.apartmentNo) === normalizePart(apartmentNo) && normalizePart(item.buildingNo) === normalizePart(buildingNo) && (!street || normalizePart(item.street) === normalizePart(street)));
      if (!flat || row.value == null || !row.date) {
        skipped += 1;
        continue;
      }

      const meterType = normalizeMeterType(row.meterType);
      const meter = activeMeters.find((item) => item.flatId === flat.id && normalizeMeterType(item.type) === meterType)
        || activeMeters.find((item) => item.flatId === flat.id);
      if (!meter) {
        skipped += 1;
        continue;
      }

      const previous = allReadings
        .filter((item) => item.meterId === meter.id)
        .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0];
      const consumption = Math.max(0, Number(row.value) - Number(previous?.value || 0));
      const tariff = tariffByType[meterType] ?? tariffByType.other;
      const chargeAmount = Number((consumption * tariff).toFixed(2));
      const period = String(row.date).slice(0, 7);

      const readingRef = doc(collection(db, "communities", communityId, "meterReadings"));
      batch.set(readingRef, {
        meterId: meter.id,
        flatId: flat.id,
        value: Number(row.value),
        date: row.date,
        source: "import",
        createdAtMs: Date.now(),
        consumption,
        chargeAmount,
        chargeAmountCents: Math.round(chargeAmount * 100),
        period,
        meterType,
        serialNumber: meter.serialNumber || "",
      });
      imported += 1;

      if (chargeAmount > 0) {
        const chargeRef = doc(collection(db, "communities", communityId, "charges"));
        batch.set(chargeRef, {
          communityId,
          flatId: flat.id,
          meterId: meter.id,
          source: "meterReadingImport",
          category: `MEDIA_${meterType.toUpperCase()}`,
          label: `Zużycie ${meterType}`,
          amount: chargeAmount,
          amountCents: Math.round(chargeAmount * 100),
          tariff,
          period,
          date: row.date,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        });
        generatedCharges += 1;
      }
    }

    await batch.commit();
    setMessage(`Import liczników zakończony. Odczyty: ${imported}, naliczenia: ${generatedCharges}, pominięte: ${skipped}.`);
  }

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Liczniki</h2>
        <p style={{ opacity: 0.8 }}>Moduł działa na istniejących danych communityId + flatId. Licznik i odczyt są przypinane do lokalu z subkolekcji <code>communities/{communityId}/flats</code>.</p>

        <div className="card" style={{ display: "grid", gap: 12 }}>
          <h3>Konfiguracja licznika</h3>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <select className="select" value={form.flatId} onChange={(e) => {
              const flat = flatOptions.find((item) => item.id === e.target.value);
              setForm((prev) => ({
                ...prev,
                flatId: e.target.value,
                street: flat?.street || prev.street,
                buildingNo: flat?.buildingNo || prev.buildingNo,
                apartmentNo: flat?.apartmentNo || prev.apartmentNo,
              }));
            }}>
              <option value="">Wybierz lokal</option>
              {flatOptions.map((flat) => <option key={flat.id} value={flat.id}>{flat.label || flat.id}</option>)}
            </select>
            <input className="input" placeholder="Ulica" value={form.street} onChange={(e) => setForm((prev) => ({ ...prev, street: e.target.value }))} />
            <input className="input" placeholder="Nr budynku" value={form.buildingNo} onChange={(e) => setForm((prev) => ({ ...prev, buildingNo: e.target.value }))} />
            <input className="input" placeholder="Nr lokalu" value={form.apartmentNo} onChange={(e) => setForm((prev) => ({ ...prev, apartmentNo: e.target.value }))} />
            <select className="select" value={form.type} onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value }))}>
              <option value="water">Woda</option>
              <option value="heat">Ciepło</option>
              <option value="gas">Gaz</option>
              <option value="electricity">Prąd</option>
              <option value="other">Inne</option>
            </select>
            <input className="input" placeholder="Numer seryjny" value={form.serialNumber} onChange={(e) => setForm((prev) => ({ ...prev, serialNumber: e.target.value }))} />
            <input className="input" placeholder="Jednostka" value={form.unit} onChange={(e) => setForm((prev) => ({ ...prev, unit: e.target.value }))} />
          </div>
          <div>
            <button className="btn" onClick={saveMeter}>Dodaj licznik</button>
          </div>
        </div>

        <div className="card" style={{ display: "grid", gap: 12 }}>
          <h3>Import odczytów</h3>
          <p style={{ opacity: 0.78 }}>CSV/XLSX: street, buildingNo, apartmentNo, meterType, value, date. System dopasowuje lokal po istniejących danych, licznik po flatId + type, liczy zużycie i tworzy charge.</p>
          <input type="file" accept=".csv,.xlsx,.xls" onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            await importReadings(file);
          }} />
        </div>

        {message ? <div style={{ color: "#8ef0c8", fontWeight: 700 }}>{message}</div> : null}

        <div className="card" style={{ display: "grid", gap: 10 }}>
          <h3>Lista liczników</h3>
          {meters.length === 0 ? <div style={{ opacity: 0.7 }}>Brak liczników.</div> : meters.slice(0, 200).map((meter) => (
            <div key={meter.id} style={{ display: "flex", gap: 10, flexWrap: "wrap", borderTop: "1px solid rgba(255,255,255,.08)", paddingTop: 10 }}>
              <strong>{buildFlatLabel(meter.street, meter.buildingNo, meter.apartmentNo) || meter.flatId}</strong>
              <span>{meter.type || "—"}</span>
              <span>{meter.serialNumber || "brak numeru"}</span>
              <span>{meter.unit || "—"}</span>
              <span>{meter.isActive === false ? "nieaktywny" : "aktywny"}</span>
            </div>
          ))}
        </div>

        <div className="card" style={{ display: "grid", gap: 10 }}>
          <h3>Ostatnie odczyty</h3>
          {readings.length === 0 ? <div style={{ opacity: 0.7 }}>Brak odczytów.</div> : readings.slice(0, 100).map((reading) => (
            <div key={reading.id} style={{ display: "flex", gap: 10, flexWrap: "wrap", borderTop: "1px solid rgba(255,255,255,.08)", paddingTop: 10 }}>
              <strong>{reading.flatId || "—"}</strong>
              <span>{reading.date || "—"}</span>
              <span>stan: {reading.value ?? "—"}</span>
              <span>zużycie: {reading.consumption ?? 0}</span>
              <span>kwota: {reading.chargeAmountCents != null ? (Number(reading.chargeAmountCents) / 100).toFixed(2) : Number(reading.chargeAmount || 0).toFixed(2)} zł</span>
              <span>{reading.source || "manual"}</span>
            </div>
          ))}
        </div>
      </div>
    </RequireAuth>
  );
}
