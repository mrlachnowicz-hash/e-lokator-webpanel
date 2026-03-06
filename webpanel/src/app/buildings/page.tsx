"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";

type Flat = { id: string; street?: string; buildingNo?: string; apartmentNo?: string };

type Grouped = { key: string; street: string; buildingNo: string; flats: number };

export default function BuildingsPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<Grouped[]>([]);

  useEffect(() => {
    if (!communityId) return;
    return onSnapshot(collection(db, "communities", communityId, "flats"), (snap) => {
      const groups = new Map<string, Grouped>();
      snap.docs.forEach((d) => {
        const data = d.data() as Flat;
        const street = String(data.street || "").trim();
        const buildingNo = String(data.buildingNo || "").trim();
        const key = `${street}|${buildingNo}`;
        if (!street && !buildingNo) return;
        const existing = groups.get(key) || { key, street, buildingNo, flats: 0 };
        existing.flats += 1;
        groups.set(key, existing);
      });
      setItems(Array.from(groups.values()).sort((a, b) => `${a.street} ${a.buildingNo}`.localeCompare(`${b.street} ${b.buildingNo}`, "pl")));
    });
  }, [communityId]);

  return (
    <RequireAuth roles={["MASTER", "ADMIN", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Budynki</h2>
        <div className="card">
          Webpanel nie tworzy ulic ani budynków. Lista poniżej jest wyliczona z lokali zapisanych przez aplikację i importy.
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          {items.length === 0 ? <div className="card">Brak budynków.</div> : items.map((b) => (
            <div key={b.key} className="card">
              <b>{b.street} {b.buildingNo}</b>
              <div style={{ opacity: 0.8 }}>Lokale: {b.flats}</div>
            </div>
          ))}
        </div>
      </div>
    </RequireAuth>
  );
}
