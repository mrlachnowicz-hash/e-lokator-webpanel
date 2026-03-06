"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, doc, getDocs, onSnapshot, query, setDoc, where, writeBatch } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";

type Flat = {
  id: string;
  street?: string;
  buildingNo?: string;
  apartmentNo?: string;
  flatLabel?: string;
  flatKey?: string;
  status?: string;
  residentUid?: string | null;
  createdAtMs?: number;
  updatedAtMs?: number;
};

type Resident = {
  uid: string;
  displayName?: string;
  email?: string;
  phone?: string;
  flatId?: string;
  role?: string;
};

export default function FlatsPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const role = String(profile?.role || "");
  const canEdit = useMemo(() => ["MASTER", "ADMIN", "ACCOUNTANT"].includes(role), [role]);

  const [items, setItems] = useState<Flat[]>([]);
  const [residentsByFlat, setResidentsByFlat] = useState<Record<string, Resident[]>>({});
  const [street, setStreet] = useState("");
  const [buildingNo, setBuildingNo] = useState("");
  const [apartmentNo, setApartmentNo] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!communityId) return;
    const unsub = onSnapshot(collection(db, "communities", communityId, "flats"), (snap) => {
      const list = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) }))
        .sort((a: any, b: any) => {
          const aKey = `${a.street || ""}|${a.buildingNo || ""}|${a.apartmentNo || ""}`;
          const bKey = `${b.street || ""}|${b.buildingNo || ""}|${b.apartmentNo || ""}`;
          return aKey.localeCompare(bKey, "pl");
        });
      setItems(list);
    });
    return unsub;
  }, [communityId]);

  useEffect(() => {
    if (!communityId) return;
    const q = query(collection(db, "users"), where("communityId", "==", communityId), where("role", "==", "RESIDENT"));
    return onSnapshot(q, (snap) => {
      const grouped: Record<string, Resident[]> = {};
      for (const d of snap.docs) {
        const data = d.data() as any;
        const flatId = String(data.flatId || "");
        if (!flatId) continue;
        (grouped[flatId] ||= []).push({
          uid: d.id,
          displayName: data.displayName,
          email: data.email,
          phone: data.phone,
          flatId,
          role: data.role,
        });
      }
      setResidentsByFlat(grouped);
    });
  }, [communityId]);

  const createFlat = async () => {
    setMsg(null);
    setErr(null);
    try {
      if (!communityId || !street.trim() || !buildingNo.trim() || !apartmentNo.trim()) {
        throw new Error("Uzupełnij ulicę, numer budynku i numer lokalu.");
      }
      const normStreet = street.trim().toLowerCase().replace(/\s+/g, " ");
      const flatKey = `${normStreet}|${buildingNo.trim()}|${apartmentNo.trim()}`;
      const existing = await getDocs(query(
        collection(db, "communities", communityId, "flats"),
        where("flatKey", "==", flatKey)
      ));
      const batch = writeBatch(db);
      const ref = existing.docs[0]?.ref ?? doc(collection(db, "communities", communityId, "flats"));
      batch.set(ref, {
        street: street.trim(),
        buildingNo: buildingNo.trim(),
        apartmentNo: apartmentNo.trim(),
        flatLabel: apartmentNo.trim(),
        flatKey,
        status: existing.docs[0]?.data()?.status || "EMPTY",
        updatedAtMs: Date.now(),
        createdAtMs: existing.docs[0]?.data()?.createdAtMs || Date.now(),
      }, { merge: true });
      await batch.commit();
      setStreet("");
      setBuildingNo("");
      setApartmentNo("");
      setMsg("Lokal zapisany.");
    } catch (e: any) {
      setErr(e?.message || "Błąd zapisu lokalu");
    }
  };

  return (
    <RequireAuth roles={["MASTER", "ADMIN", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Lokale</h2>

        {canEdit && (
          <div className="card" style={{ maxWidth: 900 }}>
            <h3>Dodaj lokal</h3>
            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr 1fr" }}>
              <input className="input" placeholder="Ulica" value={street} onChange={(e) => setStreet(e.target.value)} />
              <input className="input" placeholder="Nr budynku" value={buildingNo} onChange={(e) => setBuildingNo(e.target.value)} />
              <input className="input" placeholder="Nr lokalu" value={apartmentNo} onChange={(e) => setApartmentNo(e.target.value)} />
            </div>
            <div className="formRow" style={{ marginTop: 10 }}>
              <button className="btn" onClick={createFlat}>Zapisz</button>
              {msg ? <span style={{ color: "#8ef58e" }}>{msg}</span> : null}
              {err ? <span style={{ color: "#ff9a9a" }}>{err}</span> : null}
            </div>
          </div>
        )}

        <div style={{ display: "grid", gap: 10 }}>
          {items.length === 0 ? (
            <div className="card">Brak lokali w tej wspólnocie.</div>
          ) : items.map((f) => {
            const residents = residentsByFlat[f.id] || [];
            return (
              <div key={f.id} className="card">
                <div style={{ display: "grid", gap: 6 }}>
                  <b>{f.street || "(brak ulicy)"} {f.buildingNo || ""} / {f.apartmentNo || f.flatLabel || ""}</b>
                  <div style={{ opacity: 0.8 }}>Status: {f.status || "EMPTY"}</div>
                  <div style={{ opacity: 0.8 }}>flatId: {f.id}</div>
                  <div style={{ opacity: 0.8 }}>Klucz: {f.flatKey || "-"}</div>
                  {residents.length > 0 ? (
                    <div style={{ opacity: 0.95 }}>
                      Lokatorzy: {residents.map((r) => r.displayName || r.email || r.uid).join(", ")}
                    </div>
                  ) : (
                    <div style={{ opacity: 0.7 }}>Brak przypiętego lokatora w aplikacji.</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </RequireAuth>
  );
}
