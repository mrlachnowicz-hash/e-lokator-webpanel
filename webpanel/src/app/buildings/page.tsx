"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { displayStreetName } from "../../lib/streetUtils";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";

type Flat = { id: string; street?: string; streetId?: string; streetName?: string; buildingNo?: string; apartmentNo?: string; flatLabel?: string; residentName?: string; displayName?: string; email?: string; phone?: string; residentUid?: string | null; userId?: string | null; };
type User = { id: string; flatId?: string; displayName?: string; email?: string; phone?: string; street?: string; buildingNo?: string; apartmentNo?: string; role?: string };
type BuildingRow = { key: string; street: string; buildingNo: string; flatsCount: number; flats: Flat[] };
type StreetRow = { key: string; street: string; buildings: BuildingRow[]; flatsCount: number };

function apartment(flat: Flat) { return String(flat.apartmentNo || "").trim(); }
function flatLabel(flat: Flat) { return String(flat.flatLabel || `${flat.street || flat.streetName || ""} ${flat.buildingNo || ""}/${apartment(flat)}`.trim()); }

export default function BuildingsPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<StreetRow[]>([]);
  const [openStreetKey, setOpenStreetKey] = useState<string | null>(null);

  useEffect(() => {
    if (!communityId) return;
    let flatsCache: Flat[] = [];
    let usersByFlatId = new Map<string, User>();
    let streetsById = new Map<string, string>();

    const merge = () => {
      const streetsMap = new Map<string, StreetRow>();
      flatsCache.forEach((flat) => {
        const linkedUser = usersByFlatId.get(flat.id);
        const merged: Flat = linkedUser ? { ...flat, displayName: flat.displayName || linkedUser.displayName || "", email: flat.email || linkedUser.email || "", phone: flat.phone || linkedUser.phone || "", residentName: flat.residentName || linkedUser.displayName || "", residentUid: flat.residentUid || linkedUser.id || null, userId: flat.userId || linkedUser.id || null } : flat;
        const street = String(displayStreetName(merged.street || merged.streetName || linkedUser?.street, (merged as any).streetId, streetsById) || "").trim();
        const buildingNo = String(merged.buildingNo || linkedUser?.buildingNo || "").trim();
        if (!street || !buildingNo) return;
        const streetKey = street.toLowerCase();
        const buildingKey = `${street}|${buildingNo}`;
        const streetRow = streetsMap.get(streetKey) || { key: streetKey, street, buildings: [], flatsCount: 0 };
        let buildingRow = streetRow.buildings.find((x) => x.key === buildingKey);
        if (!buildingRow) {
          buildingRow = { key: buildingKey, street, buildingNo, flatsCount: 0, flats: [] };
          streetRow.buildings.push(buildingRow);
        }
        buildingRow.flatsCount += 1;
        buildingRow.flats.push(merged);
        streetRow.flatsCount += 1;
        streetsMap.set(streetKey, streetRow);
      });
      const sorted = Array.from(streetsMap.values()).sort((a, b) => a.street.localeCompare(b.street, "pl"));
      sorted.forEach((street) => {
        street.buildings.sort((a, b) => a.buildingNo.localeCompare(b.buildingNo, "pl", { numeric: true }));
        street.buildings.forEach((row) => row.flats.sort((a, b) => apartment(a).localeCompare(apartment(b), "pl", { numeric: true })));
      });
      setItems(sorted);
    };

    const unsubFlats = onSnapshot(query(collection(db, "communities", communityId, "flats")), (snap) => {
      flatsCache = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
      merge();
    });
    const unsubStreets = onSnapshot(query(collection(db, "communities", communityId, "streets")), (snap) => {
      streetsById = new Map(snap.docs.map((d) => [d.id, String((d.data() as any).name || d.id)]));
      merge();
    });
    const unsubUsers = onSnapshot(query(collection(db, "users"), where("communityId", "==", communityId)), (snap) => {
      usersByFlatId = new Map(
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })).filter((u: any) => String(u.flatId || "").trim()).map((u: any) => [String(u.flatId), u])
      );
      merge();
    });
    return () => { unsubFlats(); unsubUsers(); unsubStreets(); };
  }, [communityId]);

  const totalBuildings = useMemo(() => items.reduce((a, x) => a + x.buildings.length, 0), [items]);
  const totalFlats = useMemo(() => items.reduce((a, x) => a + x.flatsCount, 0), [items]);

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Budynki</h2>
        <p style={{ opacity: 0.75 }}>Kliknij ulicę, aby rozwinąć budynki, adresy lokali i listę lokatorów.</p>
        <div style={{ opacity: 0.8 }}>Łącznie ulic: {items.length} · Budynków: {totalBuildings} · Lokali: {totalFlats}</div>
        <div style={{ display: "grid", gap: 10 }}>
          {items.length === 0 ? <div style={{ opacity: 0.7 }}>Brak budynków do wyświetlenia.</div> : null}
          {items.map((streetRow) => {
            const isOpen = openStreetKey === streetRow.key;
            return (
              <div key={streetRow.key} className="card" style={{ display: "grid", gap: 12 }}>
                <button className="btnGhost" style={{ justifySelf: "start" }} onClick={() => setOpenStreetKey(isOpen ? null : streetRow.key)}>
                  {isOpen ? "Ukryj" : "Pokaż"} · <b>{streetRow.street}</b> · Budynków: {streetRow.buildings.length} · Lokali: {streetRow.flatsCount}
                </button>
                {isOpen ? (
                  <div style={{ display: "grid", gap: 12 }}>
                    {streetRow.buildings.map((building) => (
                      <div key={building.key} style={{ border: "1px solid rgba(255,255,255,0.15)", borderRadius: 12, padding: 12, display: "grid", gap: 10 }}>
                        <div><strong>{building.street} {building.buildingNo}</strong> · Lokali: {building.flatsCount}</div>
                        <div style={{ display: "grid", gap: 8 }}>
                          {building.flats.map((flat) => (
                            <div key={flat.id} style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: 10, display: "grid", gap: 4 }}>
                              <div><strong>{flatLabel(flat)}</strong></div>
                              <div style={{ opacity: 0.85 }}>Lokator: {flat.residentName || flat.displayName || "Brak przypisanego lokatora"}</div>
                              <div style={{ opacity: 0.8 }}>Email: {flat.email || "—"}</div>
                              <div style={{ opacity: 0.8 }}>Telefon: {flat.phone || "—"}</div>
                              <div style={{ opacity: 0.7, fontSize: 13 }}>flatId: {flat.id}</div>
                            </div>
                          ))}
                        </div>
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
