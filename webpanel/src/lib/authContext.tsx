"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, User } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { auth, db } from "./firebase";

export type UserProfile = {
  role?: "MASTER" | "ADMIN" | "ACCOUNTANT" | "RESIDENT" | string;
  communityId?: string;
  customerId?: string;
  displayName?: string;
  flatId?: string;
  flatLabel?: string;
  paymentsUrl?: string;
};

type AuthCtx = {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
};

const Ctx = createContext<AuthCtx>({ user: null, profile: null, loading: true });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
      setProfile(null);
      setProfileLoading(!!u);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user) return;
    const ref = doc(db, "users", user.uid);
    const unsub = onSnapshot(ref, (snap) => {
      setProfile((snap.data() || null) as any);
      setProfileLoading(false);
    }, () => {
      setProfileLoading(false);
    });
    return () => unsub();
  }, [user]);

  const loading = authLoading || (user ? profileLoading : false);

  const value = useMemo(() => ({ user, profile, loading }), [user, profile, loading]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  return useContext(Ctx);
}
