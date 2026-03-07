"use client";

import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";

type Street = { id: string; name?: string; normalizedName?: string; nameNorm?: string; createdAtMs?: number; updatedAtMs?: number; isActive?: boolean };

function normalizeStreetId(name: string) {
  return String(name || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
}

export default function StreetsPage() {
  const { profile } = useAuth();
  const communityId = String(profile?.communityId || "");
  const [items, setItems] = useState<Street[]>([]);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!communityId) return;
    const ref = query(collection(db, "communities", communityId, "streets"), orderBy("name", "asc"));
    return onSnapshot(ref, (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
  }, [communityId]);

  const activeCount = useMemo(() => items.filter((x) => x.isActive !== false).length, [items]);

  const addStreet = async () => {
    const clean = name.trim();
    if (!communityId || !clean) return;
    const id = normalizeStreetId(clean);
    await setDoc(doc(db, "communities", communityId, "streets", id), {
      id,
      communityId,
      name: clean,
      nameNorm: id,
      normalizedName: id,
      isActive: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    }, { merge: true });
    setMsg(`Dodano / zaktualizowano ulicę: ${clean}`);
    setName("");
  };

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Ulice</h2>
        <p style={{ opacity: 0.8 }}>Ta lista jest wspólna dla webpanelu i aplikacji. Dodanie ulicy tutaj powoduje jej pojawienie się u mastera w aplikacji, a ulica dodana w aplikacji będzie widoczna tutaj.</p>
        <div className="card" style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          <div>Łącznie: <strong>{items.length}</strong></div>
          <div>Aktywne: <strong>{activeCount}</strong></div>
        </div>
        <div className="card" style={{ display: "grid", gap: 12, maxWidth: 640 }}>
          <h3>Dodaj ulicę</h3>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input className="input" placeholder="Nazwa ulicy" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn" onClick={addStreet}>Zapisz</button>
          </div>
          {msg ? <div style={{ color: "#8ef0c8" }}>{msg}</div> : null}
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          {items.map((street) => (
            <div key={street.id} className="card" style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
              <div>
                <strong>{street.name || street.id}</strong>
                <div style={{ opacity: 0.7 }}>ID: {street.id}</div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btnGhost" onClick={() => updateDoc(doc(db, "communities", communityId, "streets", street.id), { isActive: street.isActive === false, updatedAtMs: Date.now() })}>
                  {street.isActive === false ? "Aktywuj" : "Archiwizuj"}
                </button>
                <button className="btnGhost" onClick={() => deleteDoc(doc(db, "communities", communityId, "streets", street.id))}>Usuń</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </RequireAuth>
  );
}
