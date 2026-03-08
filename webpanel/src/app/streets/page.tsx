"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, deleteDoc, doc, onSnapshot, orderBy, query, updateDoc } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";

type Street = {
  id: string;
  name?: string;
  normalizedName?: string;
  nameNorm?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  isActive?: boolean;
  source?: "registry" | "flats" | "mixed";
};

type Flat = { id: string; street?: string; streetId?: string };

function normalizeStreetId(name: string) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

export default function StreetsPage() {
  const { user, profile } = useAuth();
  const communityId = String(profile?.communityId || "");
  const [items, setItems] = useState<Street[]>([]);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!communityId) return;

    let registry: Street[] = [];
    let flats: Flat[] = [];

    const merge = () => {
      const byId = new Map<string, Street>();
      for (const street of registry) {
        byId.set(street.id, { ...street, source: "registry" });
      }
      for (const flat of flats) {
        const flatStreetName = String(flat.street || "").trim();
        const flatStreetId = normalizeStreetId(flatStreetName || flat.streetId || "");
        if (!flatStreetId) continue;
        const existing = byId.get(flatStreetId);
        if (existing) {
          byId.set(flatStreetId, {
            ...existing,
            name: existing.name || flatStreetName || existing.id,
            source: "mixed",
          });
        } else {
          byId.set(flatStreetId, {
            id: flatStreetId,
            name: flatStreetName || flat.streetId || flatStreetId,
            normalizedName: flatStreetId,
            nameNorm: flatStreetId,
            isActive: true,
            source: "flats",
          });
        }
      }
      const merged = Array.from(byId.values()).sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), "pl"));
      setItems(merged);
    };

    const unsubRegistry = onSnapshot(
      query(collection(db, "communities", communityId, "streets"), orderBy("name", "asc")),
      (snap) => {
        registry = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
        merge();
      },
      () => {
        registry = [];
        merge();
      },
    );

    const unsubFlats = onSnapshot(query(collection(db, "communities", communityId, "flats")), (snap) => {
      flats = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
      merge();
    });

    return () => {
      unsubRegistry();
      unsubFlats();
    };
  }, [communityId]);

  const activeCount = useMemo(() => items.filter((x) => x.isActive !== false).length, [items]);

  const addStreet = async () => {
    const clean = name.trim();
    if (!communityId || !clean || !user) return;
    setBusy(true);
    setMsg(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/upsert-street", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ communityId, name: clean }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Błąd zapisu ulicy.");
      setMsg(`Dodano / zaktualizowano ulicę: ${clean}`);
      setName("");
    } catch (e: any) {
      setMsg(e?.message || "Błąd zapisu ulicy.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Ulice</h2>
        <p style={{ opacity: 0.8 }}>
          Ta lista jest wspólna dla webpanelu i aplikacji. Pokazujemy zarówno ulice zapisane bezpośrednio w rejestrze,
          jak i ulice wykryte w lokalach zaimportowanych lub dodanych wcześniej.
        </p>
        <div className="card" style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          <div>Łącznie: <strong>{items.length}</strong></div>
          <div>Aktywne: <strong>{activeCount}</strong></div>
        </div>
        <div className="card" style={{ display: "grid", gap: 12, maxWidth: 640 }}>
          <h3>Dodaj ulicę</h3>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input
              className="input"
              placeholder="Nazwa ulicy"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addStreet();
              }}
            />
            <button className="btn" disabled={busy || !name.trim()} onClick={addStreet}>{busy ? "Zapisywanie..." : "Zapisz"}</button>
          </div>
          {msg ? <div style={{ color: msg.startsWith("Dodano") ? "#8ef0c8" : "#ffb3b3" }}>{msg}</div> : null}
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          {items.map((street) => {
            const canManage = street.source !== "flats";
            return (
              <div key={street.id} className="card" style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
                <div>
                  <strong>{street.name || street.id}</strong>
                  <div style={{ opacity: 0.7 }}>ID: {street.id}</div>
                  <div style={{ opacity: 0.7, fontSize: 13 }}>
                    Źródło: {street.source === "mixed" ? "rejestr + lokale" : street.source === "flats" ? "wykryta z lokali" : "rejestr ulic"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    className="btnGhost"
                    disabled={!canManage}
                    onClick={() => updateDoc(doc(db, "communities", communityId, "streets", street.id), { isActive: street.isActive === false, updatedAtMs: Date.now() })}
                  >
                    {street.isActive === false ? "Aktywuj" : "Archiwizuj"}
                  </button>
                  <button
                    className="btnGhost"
                    disabled={!canManage}
                    onClick={() => deleteDoc(doc(db, "communities", communityId, "streets", street.id))}
                  >
                    Usuń
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </RequireAuth>
  );
}
