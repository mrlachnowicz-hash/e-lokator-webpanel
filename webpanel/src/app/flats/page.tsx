"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { callable } from "../../lib/functions";

type Flat = {
  id: string;
  street?: string;
  buildingNo?: string;
  apartmentNo?: string;
  flatLabel?: string;
  flatNumber?: string;
  name?: string;
  surname?: string;
  email?: string;
  phone?: string;
  areaM2?: number;
  residentUid?: string | null;
  flatKey?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
};

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

export default function FlatsPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const role = String(profile?.role || "");
  const canEdit = useMemo(() => ["MASTER", "ACCOUNTANT"].includes(role), [role]);

  const [items, setItems] = useState<Flat[]>([]);
  const [street, setStreet] = useState("");
  const [buildingNo, setBuildingNo] = useState("");
  const [apartmentNo, setApartmentNo] = useState("");
  const [name, setName] = useState("");
  const [surname, setSurname] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!communityId) return;
    const q = query(collection(db, "communities", communityId, "flats"));
    return onSnapshot(q, (snap) => {
      const list = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) }))
        .sort((a: any, b: any) => Number(b.updatedAtMs || b.createdAtMs || 0) - Number(a.updatedAtMs || a.createdAtMs || 0));
      setItems(list);
    });
  }, [communityId]);

  const saveFlat = async () => {
    if (!communityId || !street.trim() || !buildingNo.trim() || !apartmentNo.trim()) return;
    setMsg(null);
    setErr(null);
    try {
      const fn = callable("upsertFlat");
      const res = await fn({
        source: "WEBPANEL",
        communityId,
        street: street.trim(),
        buildingNo: buildingNo.trim(),
        apartmentNo: apartmentNo.trim(),
        flatNumber: apartmentNo.trim(),
        flatLabel: `${street.trim()} ${buildingNo.trim()}/${apartmentNo.trim()}`,
        flatKey: buildFlatKey(communityId, street, buildingNo, apartmentNo),
        name: name.trim(),
        surname: surname.trim(),
        email: email.trim(),
        phone: phone.trim(),
        withPayer: true,
      });
      const created = Boolean((res as any)?.data?.created);
      setStreet("");
      setBuildingNo("");
      setApartmentNo("");
      setName("");
      setSurname("");
      setEmail("");
      setPhone("");
      setMsg(created ? "Dodano nowy lokal i zużyto 1 seat." : "Zaktualizowano istniejący lokal.");
    } catch (e: any) {
      setErr(e?.message || "Błąd zapisu lokalu");
    }
  };

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Lokale</h2>

        {canEdit && (
          <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16, maxWidth: 980 }}>
            <h3>Dodaj lub zaktualizuj lokal</h3>
            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr 1fr" }}>
              <input placeholder="Ulica" value={street} onChange={(e) => setStreet(e.target.value)} />
              <input placeholder="Nr budynku" value={buildingNo} onChange={(e) => setBuildingNo(e.target.value)} />
              <input placeholder="Nr lokalu" value={apartmentNo} onChange={(e) => setApartmentNo(e.target.value)} />
              <input placeholder="Imię" value={name} onChange={(e) => setName(e.target.value)} />
              <input placeholder="Nazwisko" value={surname} onChange={(e) => setSurname(e.target.value)} />
              <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <input placeholder="Telefon" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <button style={{ marginTop: 10 }} onClick={saveFlat}>Zapisz</button>
            {msg ? <div style={{ marginTop: 10, color: "green" }}>{msg}</div> : null}
            {err ? <div style={{ marginTop: 10, color: "crimson" }}>{err}</div> : null}
          </div>
        )}

        <div style={{ display: "grid", gap: 10 }}>
          {items.length === 0 ? <div style={{ opacity: 0.7 }}>Brak lokali do wyświetlenia.</div> : null}
          {items.map((f) => (
            <div key={f.id} style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <b>{f.flatLabel || `${f.street || ""} ${f.buildingNo || ""}/${f.apartmentNo || f.flatNumber || ""}`.trim()}</b>
                <span style={{ opacity: 0.8 }}>{(f.name || "")} {(f.surname || "")}</span>
                <span style={{ opacity: 0.7 }}>{f.email || ""}</span>
                <span style={{ opacity: 0.7 }}>{f.phone || ""}</span>
                {f.areaM2 ? <span style={{ opacity: 0.7 }}>{f.areaM2} m²</span> : null}
                <span style={{ opacity: 0.7 }}>{f.residentUid ? "Użytkownik przypisany" : "Brak użytkownika app"}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </RequireAuth>
  );
}
