"use client";

import { useState } from "react";
import { doc, setDoc } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { callable } from "../../lib/functions";

export default function DashboardPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const role = String(profile?.role || "");

  return (
    <RequireAuth roles={["MASTER", "ADMIN", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16, maxWidth: 900 }}>
        <h2>Panel</h2>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16 }}>
          <h3>SSO / Płatności</h3>
          <p style={{ opacity: 0.75 }}>
            Aplikacja Android czyta <code>communities/{communityId}/paymentsUrl</code> i otwiera WebView.
          </p>
          <SetPaymentsUrl communityId={communityId} />
        </div>

        {(role === "MASTER" || role === "ADMIN") && (
          <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16 }}>
            <h3>Kod rejestracji księgowej</h3>
            <p style={{ opacity: 0.75 }}>Wygeneruj kod (join code) i przekaż księgowej.</p>
            <JoinCode communityId={communityId} />
          </div>
        )}

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 16 }}>
          <h3>KSeF – konfiguracja (MVP)</h3>
          <KsefConfig communityId={communityId} />
        </div>
      </div>
    </RequireAuth>
  );
}

function SetPaymentsUrl({ communityId }: { communityId: string }) {
  const [url, setUrl] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <input placeholder="np. https://panel.e-lokator.org/sso" value={url} onChange={(e) => setUrl(e.target.value)} />
      <button
        onClick={async () => {
          setMsg(null);
          if (!communityId) return;
          await setDoc(doc(db, "communities", communityId), { paymentsUrl: url }, { merge: true });
          setMsg("Zapisano paymentsUrl");
        }}
      >
        Zapisz
      </button>
      {msg && <div style={{ color: "green" }}>{msg}</div>}
    </div>
  );
}

function JoinCode({ communityId }: { communityId: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <button
        onClick={async () => {
          setErr(null);
          try {
            const fn = callable<{ role: string; communityId: string }, any>("createJoinCode");
            const res = await fn({ role: "ACCOUNTANT", communityId });
            setCode((res.data as any).code);
          } catch (e: any) {
            setErr(e?.message || "Błąd");
          }
        }}
      >
        Generuj kod
      </button>
      {code && (
        <div>
          <b>{code}</b>
        </div>
      )}
      {err && <div style={{ color: "crimson" }}>{err}</div>}
    </div>
  );
}

function KsefConfig({ communityId }: { communityId: string }) {
  const [mode, setMode] = useState("MOCK");
  const [identifier, setIdentifier] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div style={{ display: "grid", gap: 10, maxWidth: 520 }}>
      <label>
        Tryb:
        <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ marginLeft: 8 }}>
          <option value="MOCK">MOCK</option>
          <option value="KSEF">KSEF (TODO)</option>
        </select>
      </label>
      <input placeholder="Identyfikator (np. NIP wspólnoty)" value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
      <button
        onClick={async () => {
          const fn = callable<any, any>("ksefSetConfig");
          await fn({ communityId, mode, identifier });
          setMsg("Zapisano konfigurację");
        }}
      >
        Zapisz
      </button>
      {msg && <div style={{ color: "green" }}>{msg}</div>}
    </div>
  );
}
