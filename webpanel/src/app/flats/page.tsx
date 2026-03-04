"use client";

import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, doc, onSnapshot, orderBy, query, setDoc } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";

type Flat = {
  id: string;
  buildingId?: string;
  building?: string;
  flatNumber?: string;
  name?: string;
  surname?: string;
  email?: string;
  phone?: string;
  areaM2?: number;
  createdAtMs?: number;
};

export default function FlatsPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const role = String(profile?.role || "");
  const canEdit = useMemo(() => ["MASTER", "ADMIN", "ACCOUNTANT"].includes(role), [role]);

  const [items, setItems] = useState<Flat[]>([]);
  const [flatNumber, setFlatNumber] = useState("");
  const [building, setBuilding] = useState("");
  const [name, setName] = useState("");
  const [surname, setSurname] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  useEffect(() => {
    if (!communityId) return;
    const q = query(collection(db, "communities", communityId, "flats"), orderBy("createdAtMs", "desc"));
    return onSnapshot(q, (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
  }, [communityId]);

  return (
    <RequireAuth roles={["MASTER", "ADMIN", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Lokale</h2>

        {canEdit && (
          <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16, maxWidth: 900 }}>
            <h3>Dodaj lokal</h3>
            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}>
              <input placeholder="Budynek (nazwa/skrót)" value={building} onChange={(e) => setBuilding(e.target.value)} />
              <input placeholder="Nr lokalu" value={flatNumber} onChange={(e) => setFlatNumber(e.target.value)} />
              <input placeholder="Imię" value={name} onChange={(e) => setName(e.target.value)} />
              <input placeholder="Nazwisko" value={surname} onChange={(e) => setSurname(e.target.value)} />
              <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <input placeholder="Telefon" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <button
              style={{ marginTop: 10 }}
              onClick={async () => {
                if (!communityId || !flatNumber.trim()) return;
                await addDoc(collection(db, "communities", communityId, "flats"), {
                  building: building.trim(),
                  flatNumber: flatNumber.trim(),
                  name: name.trim(),
                  surname: surname.trim(),
                  email: email.trim(),
                  phone: phone.trim(),
                  createdAtMs: Date.now(),
                  seatUsed: true
                });
                setBuilding("");
                setFlatNumber("");
                setName("");
                setSurname("");
                setEmail("");
                setPhone("");
              }}
            >
              Zapisz
            </button>
          </div>
        )}

        <div style={{ display: "grid", gap: 10 }}>
          {items.map((f) => (
            <div key={f.id} style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <b>{f.building || ""} / {f.flatNumber || ""}</b>
                <span style={{ opacity: 0.8 }}>{(f.name || "")} {(f.surname || "")}</span>
                <span style={{ opacity: 0.7 }}>{f.email || ""}</span>
                <div style={{ flex: 1 }} />
                {canEdit && (
                  <button
                    onClick={async () => {
                      await setDoc(doc(db, "communities", communityId, "flats", f.id), { updatedAtMs: Date.now() }, { merge: true });
                    }}
                  >
                    Edytuj (TODO)
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </RequireAuth>
  );
}
