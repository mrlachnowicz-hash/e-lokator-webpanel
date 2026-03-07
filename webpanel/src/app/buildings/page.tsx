"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";

type Flat = { id: string; street?: string; buildingNo?: string; apartmentNo?: string; flatLabel?: string; residentName?: string; displayName?: string; email?: string; phone?: string; residentUid?: string | null; userId?: string | null; };
type User = { id: string; flatId?: string; displayName?: string; email?: string; phone?: string; street?: string; buildingNo?: string; apartmentNo?: string; role?: string };
type BuildingRow = { key: string; street: string; buildingNo: string; flatsCount: number; flats: Flat[] };

function apartment(flat: Flat) { return String(flat.apartmentNo || "").trim(); }
function flatLabel(flat: Flat) { return String(flat.flatLabel || `${flat.street || ""} ${flat.buildingNo || ""}/${apartment(flat)}`.trim()); }

export default function BuildingsPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<BuildingRow[]>([]);
  const [openKey, setOpenKey] = useState<string | null>(null);

  useEffect(() => {
    if (!communityId) return;
    let flatsCache: Flat[] = [];
    let usersByFlatId = new Map<string, User>();

    const merge = () => {
      const map = new Map<string, BuildingRow>();
      flatsCache.forEach((flat) => {
        const linkedUser = usersByFlatId.get(flat.id);
        const merged: Flat = linkedUser ? { ...flat, displayName: flat.displayName || linkedUser.displayName || "", email: flat.email || linkedUser.email || "", phone: flat.phone || linkedUser.phone || "", residentName: flat.residentName || linkedUser.displayName || "", residentUid: flat.residentUid || linkedUser.id || null, userId: flat.userId || linkedUser.id || null } : flat;
        const street = String(merged.street || linkedUser?.street || "");
        const buildingNo = String(merged.buildingNo || linkedUser?.buildingNo || "");
        const key = `${street}|${buildingNo}`;
        const row = map.get(key) || { key, street, buildingNo, flatsCount: 0, flats: [] };
        row.flatsCount += 1;
        row.flats.push(merged);
        map.set(key, row);
      });
      const sorted = Array.from(map.values()).sort((a, b) => a.street.localeCompare(b.street, "pl") || a.buildingNo.localeCompare(b.buildingNo, "pl", { numeric: true }));
      sorted.forEach((row) => row.flats.sort((a, b) => apartment(a).localeCompare(apartment(b), "pl", { numeric: true })));
      setItems(sorted);
    };

    const unsubFlats = onSnapshot(query(collection(db, "communities", communityId, "flats")), (snap) => {
      flatsCache = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
      merge();
    });
    const unsubUsers = onSnapshot(query(collection(db, "users"), where("communityId", "==", communityId)), (snap) => {
      usersByFlatId = new Map(
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })).filter((u: any) => String(u.flatId || "").trim()).map((u: any) => [String(u.flatId), u])
      );
      merge();
    });
    return () => { unsubFlats(); unsubUsers(); };
  }, [communityId]);

  const total = useMemo(() => items.reduce((a, x) => a + x.flatsCount, 0), [items]);

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Budynki</h2>
        <p style={{ opacity: 0.75 }}>Kliknij budynek, aby rozwinąć adresy lokali i listę lokatorów.</p>
        <div style={{ opacity: 0.8 }}>Łącznie budynków: {items.length} · Łącznie lokali: {total}</div>
        <div style={{ display: "grid", gap: 10 }}>
          {items.length === 0 ? <div style={{ opacity: 0.7 }}>Brak budynków do wyświetlenia.</div> : null}
          {items.map((b) => {
            const isOpen = openKey === b.key;
            return (
              <div key={b.key} className="card" style={{ display: "grid", gap: 12 }}>
                <button className="btnGhost" style={{ justifySelf: "start" }} onClick={() => setOpenKey(isOpen ? null : b.key)}>
                  {isOpen ? "Ukryj" : "Pokaż"} · <b>{b.street} {b.buildingNo}</b> · Lokali: {b.flatsCount}
                </button>
                {isOpen ? (
                  <div style={{ display: "grid", gap: 10 }}>
                    {b.flats.map((flat) => (
                      <div key={flat.id} style={{ border: "1px solid rgba(255,255,255,0.15)", borderRadius: 12, padding: 12, display: "grid", gap: 6 }}>
                        <div><strong>{flatLabel(flat)}</strong></div>
                        <div style={{ opacity: 0.85 }}>Lokator: {flat.residentName || flat.displayName || "Brak przypisanego lokatora"}</div>
                        <div style={{ opacity: 0.8 }}>Email: {flat.email || "—"}</div>
                        <div style={{ opacity: 0.8 }}>Telefon: {flat.phone || "—"}</div>
                        <div style={{ opacity: 0.7, fontSize: 13 }}>flatId: {flat.id}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </RequireAuth>
  );
}
