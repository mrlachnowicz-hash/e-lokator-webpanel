"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";

type Flat = { id: string; street?: string; buildingNo?: string; apartmentNo?: string };

type BuildingRow = { key: string; street: string; buildingNo: string; flatsCount: number };

export default function BuildingsPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<BuildingRow[]>([]);

  useEffect(() => {
    if (!communityId) return;
    const q = query(collection(db, "communities", communityId, "flats"));
    return onSnapshot(q, (snap) => {
      const map = new Map<string, BuildingRow>();
      snap.docs.forEach((d) => {
        const x = d.data() as Flat;
        const street = String(x.street || "");
        const buildingNo = String(x.buildingNo || "");
        const key = `${street}|${buildingNo}`;
        const current = map.get(key) || { key, street, buildingNo, flatsCount: 0 };
        current.flatsCount += 1;
        map.set(key, current);
      });
      setItems(Array.from(map.values()).sort((a, b) => a.street.localeCompare(b.street) || a.buildingNo.localeCompare(b.buildingNo)));
    });
  }, [communityId]);

  const total = useMemo(() => items.reduce((a, x) => a + x.flatsCount, 0), [items]);

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Budynki</h2>
        <p style={{ opacity: 0.75 }}>Lista budynków jest wyliczana z lokali zapisanych przez aplikację i webpanel. Webpanel nie tworzy ulic ani budynków jako osobnych rekordów źródłowych.</p>
        <div style={{ opacity: 0.8 }}>Łącznie budynków: {items.length} · Łącznie lokali: {total}</div>
        <div style={{ display: "grid", gap: 10 }}>
          {items.length === 0 ? <div style={{ opacity: 0.7 }}>Brak budynków do wyświetlenia.</div> : null}
          {items.map((b) => (
            <div key={b.key} style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <b>{b.street} {b.buildingNo}</b>
                <span style={{ opacity: 0.7 }}>Lokali: {b.flatsCount}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </RequireAuth>
  );
}
