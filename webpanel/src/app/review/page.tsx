"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { callable } from "../../lib/functions";

export default function ReviewPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<any[]>([]);
  const [explains, setExplains] = useState<Record<string, any>>({});

  useEffect(() => {
    if (!communityId) return;
    const q = query(collection(db, "communities", communityId, "reviewQueue"), orderBy("createdAtMs", "desc"));
    return onSnapshot(q, (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
  }, [communityId]);

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 12 }}>
        <h2>Review queue</h2>
        <p style={{ opacity: 0.8, marginTop: -8 }}>Tu trafiają wyjątki z reguł, heurystyk i AI. Rekord można wyjaśnić przez AI, poprawić ręcznie i dopiero potem zamknąć.</p>
        {items.map((item) => (
          <div key={item.id} className="card" style={{ display: "grid", gap: 10 }}>
            <div><strong>{item.type || "ITEM"}</strong> — status: {item.status || "OPEN"}</div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(item, null, 2)}</pre>
            {explains[item.id] ? (
              <div style={{ background: "rgba(255,255,255,.05)", padding: 12, borderRadius: 12 }}>
                <div><strong>AI wyjaśnienie:</strong> {explains[item.id].explanation || "—"}</div>
                <div><strong>Co sprawdzić:</strong> {explains[item.id].nextAction || "—"}</div>
                <div><strong>Pewność:</strong> {explains[item.id].confidence ?? "—"}</div>
              </div>
            ) : null}
            <div className="formRow">
              <button className="btnGhost" onClick={async () => {
                const res = await fetch("/api/ai/review-explain", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(item),
                });
                const data = await res.json();
                if (res.ok) setExplains((prev) => ({ ...prev, [item.id]: data }));
              }}>AI wyjaśnij</button>
              {item.status !== "CLOSED" ? (
                <button className="btn" onClick={async () => { await callable("closeReviewItem")({ communityId, reviewId: item.id, status: "CLOSED", resolution: "closed-from-webpanel" }); }}>Zamknij</button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </RequireAuth>
  );
}
