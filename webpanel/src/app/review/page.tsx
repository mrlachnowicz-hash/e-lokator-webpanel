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
        {items.map((item) => (
          <div key={item.id} className="card" style={{ display: "grid", gap: 10 }}>
            <div><strong>{item.type || "ITEM"}</strong> — status: {item.status || "OPEN"}</div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(item, null, 2)}</pre>
            {item.status !== "CLOSED" ? (
              <div className="formRow">
                <button className="btn" onClick={async () => { await callable("closeReviewItem")({ communityId, reviewId: item.id, status: "CLOSED", resolution: "closed-from-webpanel" }); }}>Zamknij</button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </RequireAuth>
  );
}
