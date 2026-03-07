"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { auth } from "../../lib/firebase";
import { callable } from "../../lib/functions";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div style={{ padding: 32, maxWidth: 520, margin: "0 auto" }}>
      <h2>Rejestracja księgowej</h2>
      <p style={{ opacity: 0.8, marginBottom: 16 }}>
        Podaj email, hasło i <b>jednorazowy kod wygenerowany przez MASTERA</b> w dashboardzie webpanelu.
        Po poprawnej rejestracji kod zostanie zużyty, a później księgowa loguje się już tylko mailem i hasłem.
      </p>
      <div style={{ display: "grid", gap: 10 }}>
        <input className="input" placeholder="Email księgowej" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" placeholder="Hasło księgowej" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <input className="input" placeholder="Jednorazowy kod od MASTERA" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        <button
          className="btn"
          disabled={loading || !email.trim() || !password || !code.trim()}
          onClick={async () => {
            setErr(null);
            setLoading(true);
            try {
              await createUserWithEmailAndPassword(auth, email.trim(), password);
              const claim = callable<{ code: string }, any>("claimJoinCode");
              await claim({ code: code.trim().toUpperCase() });
              router.replace("/dashboard");
            } catch (e: any) {
              setErr(e?.message || "Błąd rejestracji");
            } finally {
              setLoading(false);
            }
          }}
        >
          {loading ? "Rejestracja..." : "Zarejestruj księgową"}
        </button>
        {err && <div style={{ color: "crimson" }}>{err}</div>}
      </div>

      <div style={{ marginTop: 16 }}>
        <Link href="/login">Powrót do logowania</Link>
      </div>
    </div>
  );
}
