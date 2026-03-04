"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signOut, User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "./firebase";

type Role = "MASTER" | "ADMIN" | "ACCOUNTANT" | "RESIDENT" | null;

type AuthCtx = {
  user: User | null;
  loading: boolean;
  role: Role;
  communityId: string | null;
  logout: () => Promise<void>;
  error: string | null;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<Role>(null);
  const [communityId, setCommunityId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setLoading(true);
      setError(null);

      try {
        setUser(u);

        if (!u) {
          setRole(null);
          setCommunityId(null);
          return;
        }

        // Profil użytkownika (nie może blokować całej aplikacji w nieskończoność)
        const snap = await getDoc(doc(db, "users", u.uid));
        const data = snap.exists() ? (snap.data() as any) : null;

        setRole((data?.role as Role) ?? null);

        // Różne nazwy w projektach – próbujemy kilku
        setCommunityId(
          data?.communityId ??
            data?.activeCommunityId ??
            data?.community ??
            null
        );
      } catch (e: any) {
        console.error("AuthProvider error:", e);
        setError(e?.message ?? String(e));
        // NIE blokuj UI – pozwól wejść i pokaż błąd w ekranach
        setRole(null);
        setCommunityId(null);
      } finally {
        setLoading(false);
      }
    });

    return () => unsub();
  }, []);

  const logout = async () => {
    try {
      await signOut(auth);
    } finally {
      // nawet jeśli signOut się wywali, nie zostawiaj spinners
      setUser(null);
      setRole(null);
      setCommunityId(null);
      setLoading(false);
    }
  };

  const value = useMemo<AuthCtx>(
    () => ({ user, loading, role, communityId, logout, error }),
    [user, loading, role, communityId, error]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used within AuthProvider");
  return v;
}
