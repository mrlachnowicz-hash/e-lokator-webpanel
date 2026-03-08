"use client";

import { useEffect, useState } from "react";
import { collection, deleteDoc, doc, onSnapshot, orderBy, query, updateDoc } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";

export default function ReviewPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<any[]>([]);
  const [explains, setExplains] = useState<Record<string, any>>({});
  const [busyId, setBusyId] = useState("");

  useEffect(() => {
    if (!communityId) return;
    const q = query(collection(db, "communities", communityId, "reviewQueue"), orderBy("createdAtMs", "desc"));
    return onSnapshot(q, (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
  }, [communityId]);

  async function mark(itemId: string, patch: Record<string, any>) {
    setBusyId(itemId);
    try {
      await updateDoc(doc(db, "communities", communityId, "reviewQueue", itemId), { ...patch, updatedAtMs: Date.now() });
    } finally {
      setBusyId("");
    }
  }

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 12 }}>
        <h2>Review queue</h2>
        <p style={{ opacity: 0.8, marginTop: -8 }}>Tu trafiają wyjątki z reguł, heurystyk i AI. Rekord można wyjaśnić przez AI, zaakceptować, wyczyścić albo usunąć.</p>
        {items.map((item) => (
          <div key={item.id} className="card" style={{ display: "grid", gap: 10 }}>
            <div><strong>{item.type || "ITEM"}</strong> — status: {item.status || "OPEN"}</div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(item, null, 2)}</pre>
            {explains[item.id] || item.aiExplanation ? (
              <div style={{ background: "rgba(255,255,255,.05)", padding: 12, borderRadius: 12 }}>
                <div><strong>AI wyjaśnienie:</strong> {(explains[item.id] || item.aiExplanation)?.explanation || (explains[item.id] || item.aiExplanation)?.summary || "—"}</div>
                <div><strong>Co sprawdzić:</strong> {(explains[item.id] || item.aiExplanation)?.nextAction || (explains[item.id] || item.aiExplanation)?.recommendedChecks?.join(", ") || "—"}</div>
                <div><strong>Pewność:</strong> {(explains[item.id] || item.aiExplanation)?.confidence ?? "—"}</div>
              </div>
            ) : null}
            <div className="formRow" style={{ flexWrap: "wrap" }}>
              <button className="btnGhost" disabled={busyId === item.id} onClick={async () => {
                setBusyId(item.id);
                try {
                  const res = await fetch("/api/ai/review-explain", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(item),
                  });
                  const data = await res.json();
                  if (res.ok) setExplains((prev) => ({ ...prev, [item.id]: data }));
                } finally {
                  setBusyId("");
                }
              }}>AI wyjaśnij</button>
              <button className="btn" disabled={busyId === item.id} onClick={() => mark(item.id, { status: "ACCEPTED", resolution: "accepted-from-webpanel", closedAtMs: Date.now() })}>Zaakceptuj</button>
              <button className="btnGhost" disabled={busyId === item.id} onClick={() => mark(item.id, { status: "CLOSED", resolution: "cleared-from-webpanel", closedAtMs: Date.now() })}>Wyczyść</button>
              <button className="btnGhost" disabled={busyId === item.id} onClick={async () => {
                if (!window.confirm(`Usunąć rekord review ${item.id}?`)) return;
                setBusyId(item.id);
                try {
                  await deleteDoc(doc(db, "communities", communityId, "reviewQueue", item.id));
                } finally {
                  setBusyId("");
                }
              }}>Usuń</button>
            </div>
          </div>
        ))}
      </div>
    </RequireAuth>
  );
}
