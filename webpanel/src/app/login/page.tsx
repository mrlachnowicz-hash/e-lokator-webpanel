"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithEmailAndPassword } from "firebase/auth";
import Link from "next/link";
import { auth } from "../../lib/firebase";
import { useAuth } from "../../lib/authContext";

type Mode = "MASTER" | "ACCOUNTANT";

const MODE_TEXT: Record<Mode, { subtitle: string; email: string; password: string; button: string }> = {
  MASTER: {
    subtitle: "Dostęp właściciela wspólnoty / spółdzielni.",
    email: "Email mastera",
    password: "Hasło mastera",
    button: "Zaloguj jako MASTER",
  },
  ACCOUNTANT: {
    subtitle: "Dostęp księgowej do rozliczeń i dodawania lokali.",
    email: "Email księgowej",
    password: "Hasło księgowej",
    button: "Zaloguj jako KSIĘGOWA",
  },
};

export default function LoginPage() {
  const router = useRouter();
  const { user, profile, community, loading } = useAuth();
  const [mode, setMode] = useState<Mode>("MASTER");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (loading || !user) return;

    const role = String(profile?.role || "");
    if (!role) return;

    if (!["MASTER", "ACCOUNTANT"].includes(role)) {
      setErr("Ta rola nie ma dostępu do webpanelu. Dostęp mają tylko MASTER i ACCOUNTANT. Lokator oraz ADMIN korzystają z aplikacji mobilnej.");
      return;
    }

    const panelEnabled = community?.panelAccessEnabled === true || String((community as any)?.panelAccessEnabled || "").toLowerCase() === "true";
    if (!panelEnabled) {
      setErr("Panel nie jest aktywny dla tej wspólnoty. Włącz przełącznik „Udziel dostępu do panelu” w generatorze ownera.");
      return;
    }

    router.replace("/dashboard");
  }, [loading, user, profile, community, router]);

  const login = async () => {
    setErr(null);
    setSubmitting(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (e: any) {
      setErr(e?.message || "Błąd logowania.");
    } finally {
      setSubmitting(false);
    }
  };

  const copy = MODE_TEXT[mode];

  return (
    <div style={{ padding: 32, maxWidth: 520, margin: "0 auto" }}>
      <h2>Logowanie</h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 16, marginBottom: 16 }}>
        <button
          className="btn"
          style={{ opacity: mode === "MASTER" ? 1 : 0.72 }}
          onClick={() => {
            setMode("MASTER");
            setErr(null);
          }}
        >
          Logowanie MASTERA
        </button>
        <button
          className="btn"
          style={{ opacity: mode === "ACCOUNTANT" ? 1 : 0.72 }}
          onClick={() => {
            setMode("ACCOUNTANT");
            setErr(null);
          }}
        >
          Logowanie księgowej
        </button>
      </div>

      <p style={{ opacity: 0.8, marginBottom: 16 }}>{copy.subtitle}</p>

      <div style={{ display: "grid", gap: 10 }}>
        <input className="input" placeholder={copy.email} value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" placeholder={copy.password} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="btn" onClick={login} disabled={submitting || !email.trim() || !password}>
          {submitting ? "Logowanie..." : copy.button}
        </button>
        {err && <div style={{ color: "crimson" }}>{err}</div>}
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3>Rejestracja księgowej</h3>
        <p style={{ marginBottom: 12 }}>
          Księgowa rejestruje konto tylko raz, używając <b>jednorazowego kodu wygenerowanego przez MASTERA</b> w dashboardzie.
          Po rejestracji loguje się już zwykłym mailem i hasłem.
        </p>
        <Link href="/register" className="btn" style={{ display: "inline-block", textDecoration: "none" }}>
          Zarejestruj księgową
        </Link>
      </div>
    </div>
  );
}
