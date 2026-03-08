"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { normalizeStreetId } from "../../lib/streetUtils";

type Street = {
  id: string;
  name?: string;
  normalizedName?: string;
  nameNorm?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  isActive?: boolean;
  deletedAtMs?: number | null;
  source?: "registry" | "flats" | "mixed";
};

type Flat = { id: string; street?: string; streetId?: string };

export default function StreetsPage() {
  const { user, profile } = useAuth();
  const communityId = String(profile?.communityId || "");
  const [items, setItems] = useState<Street[]>([]);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!communityId) return;

    let registry: Street[] = [];
    let flats: Flat[] = [];

    const merge = () => {
      const byId = new Map<string, Street>();
      const deletedIds = new Set<string>();
      for (const street of registry) {
        const id = street.id;
        if (street.deletedAtMs) {
          deletedIds.add(id);
          continue;
        }
        byId.set(id, { ...street, source: "registry" });
      }
      for (const flat of flats) {
        const flatStreetName = String(flat.street || "").trim();
        const flatStreetId = normalizeStreetId(flatStreetName || flat.streetId || "");
        if (!flatStreetId || deletedIds.has(flatStreetId)) continue;
        const existing = byId.get(flatStreetId);
        if (existing) {
          byId.set(flatStreetId, { ...existing, name: existing.name || flatStreetName || existing.id, source: "mixed" });
        } else {
          byId.set(flatStreetId, { id: flatStreetId, name: flatStreetName || flat.streetId || flatStreetId, normalizedName: flatStreetId, nameNorm: flatStreetId, isActive: true, source: "flats" });
        }
      }
      const merged = Array.from(byId.values()).sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), "pl"));
      setItems(merged);
    };

    const unsubRegistry = onSnapshot(query(collection(db, "communities", communityId, "streets"), orderBy("name", "asc")), (snap) => {
      registry = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
      merge();
    });
    const unsubFlats = onSnapshot(query(collection(db, "communities", communityId, "flats")), (snap) => {
      flats = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
      merge();
    });
    return () => { unsubRegistry(); unsubFlats(); };
  }, [communityId]);

  const activeCount = useMemo(() => items.filter((x) => x.isActive !== false).length, [items]);

  const callApi = async (path: string, payload: any, success: string) => {
    if (!user) return;
    setMsg(null);
    setBusyId(payload?.streetId || payload?.name || "new");
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Błąd operacji na ulicy.");
      setMsg(success);
      if (path.includes("upsert")) setName("");
    } catch (e: any) {
      setMsg(e?.message || "Błąd operacji na ulicy.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Ulice</h2>
        <p style={{ opacity: 0.8 }}>Lista łączy rejestr ulic z adresami wykrytymi w lokalach. Usunięta ulica znika także z list wyboru w panelu.</p>
        <div className="card" style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          <div>Łącznie: <strong>{items.length}</strong></div>
          <div>Aktywne: <strong>{activeCount}</strong></div>
        </div>
        <div className="card" style={{ display: "grid", gap: 12, maxWidth: 640 }}>
          <h3>Dodaj ulicę</h3>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input className="input" placeholder="Nazwa ulicy" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) void callApi("/api/upsert-street", { communityId, name: name.trim() }, `Dodano / zaktualizowano ulicę: ${name.trim()}`); }} />
            <button className="btn" disabled={busyId === "new" || !name.trim()} onClick={() => callApi("/api/upsert-street", { communityId, name: name.trim() }, `Dodano / zaktualizowano ulicę: ${name.trim()}`)}>{busyId === "new" ? "Zapisywanie..." : "Zapisz"}</button>
          </div>
          {msg ? <div style={{ color: msg.startsWith("Dodano") || msg.startsWith("Usunięto") || msg.startsWith("Zarchiwizowano") || msg.startsWith("Przywrócono") ? "#8ef0c8" : "#ffb3b3" }}>{msg}</div> : null}
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          {items.map((street) => (
            <div key={street.id} className="card" style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
              <div>
                <strong>{street.name || street.id}</strong>
                <div style={{ opacity: 0.7 }}>ID: {street.id}</div>
                <div style={{ opacity: 0.7, fontSize: 13 }}>Źródło: {street.source === "mixed" ? "rejestr + lokale" : street.source === "flats" ? "wykryta z lokali" : "rejestr ulic"}</div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btnGhost" disabled={busyId === street.id} onClick={() => callApi("/api/upsert-street", { communityId, name: street.name || street.id }, `${street.isActive === false ? "Przywrócono" : "Zarchiwizowano"} ulicę: ${street.name || street.id}`)}>{street.isActive === false ? "Aktywuj" : "Archiwizuj"}</button>
                <button className="btnGhost" disabled={busyId === street.id} onClick={() => { if (window.confirm(`Usunąć ulicę ${street.name || street.id}?`)) void callApi("/api/delete-street", { communityId, streetId: street.id, name: street.name || street.id }, `Usunięto ulicę: ${street.name || street.id}`); }}>Usuń</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </RequireAuth>
  );
}
