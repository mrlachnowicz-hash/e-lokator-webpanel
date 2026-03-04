"use client";

import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, onSnapshot, orderBy, query, setDoc, doc } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";

type Building = { id: string; name?: string; address?: string; createdAtMs?: number };

export default function BuildingsPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<Building[]>([]);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");

  useEffect(() => {
    if (!communityId) return;
    const q = query(collection(db, "communities", communityId, "buildings"), orderBy("createdAtMs", "desc"));
    return onSnapshot(q, (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })));
    });
  }, [communityId]);

  const canEdit = useMemo(() => ["MASTER", "ADMIN", "ACCOUNTANT"].includes(String(profile?.role || "")), [profile?.role]);

  return (
    <RequireAuth roles={["MASTER", "ADMIN", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Budynki</h2>

        {canEdit && (
          <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16, maxWidth: 700 }}>
            <h3>Dodaj budynek</h3>
            <div style={{ display: "grid", gap: 10 }}>
              <input placeholder="Nazwa" value={name} onChange={(e) => setName(e.target.value)} />
              <input placeholder="Adres" value={address} onChange={(e) => setAddress(e.target.value)} />
              <button
                onClick={async () => {
                  if (!communityId || !name.trim()) return;
                  await addDoc(collection(db, "communities", communityId, "buildings"), {
                    name: name.trim(),
                    address: address.trim(),
                    createdAtMs: Date.now(),
                  });
                  setName("");
                  setAddress("");
                }}
              >
                Zapisz
              </button>
            </div>
          </div>
        )}

        <div style={{ display: "grid", gap: 10 }}>
          {items.map((b) => (
            <div key={b.id} style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <b>{b.name || "(bez nazwy)"}</b>
                <span style={{ opacity: 0.7 }}>{b.address || ""}</span>
                <div style={{ flex: 1 }} />
                {canEdit && (
                  <button
                    onClick={async () => {
                      await setDoc(doc(db, "communities", communityId, "buildings", b.id), { updatedAtMs: Date.now() }, { merge: true });
                    }}
                  >
                    Odśwież
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
