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

export type CommunityProfile = {
  name?: string;
  blocked?: boolean;
  panelAccessEnabled?: boolean;
  webpanelUrl?: string;
  paymentsUrl?: string;
};

type AuthCtx = {
  user: User | null;
  profile: UserProfile | null;
  community: CommunityProfile | null;
  loading: boolean;
};

const Ctx = createContext<AuthCtx>({ user: null, profile: null, community: null, loading: true });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [community, setCommunity] = useState<CommunityProfile | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const [profileResolved, setProfileResolved] = useState(false);
  const [communityResolved, setCommunityResolved] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setProfile(null);
      setCommunity(null);
      setAuthResolved(true);
      setProfileResolved(!u);
      setCommunityResolved(!u);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user) return;
    setProfileResolved(false);
    const ref = doc(db, "users", user.uid);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        setProfile((snap.data() || null) as any);
        setProfileResolved(true);
      },
      () => {
        setProfile(null);
        setProfileResolved(true);
      }
    );
    return () => unsub();
  }, [user]);

  useEffect(() => {
    const communityId = String(profile?.communityId || "");
    if (!user || !communityId) {
      setCommunity(null);
      setCommunityResolved(true);
      return;
    }
    setCommunityResolved(false);
    const ref = doc(db, "communities", communityId);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        setCommunity((snap.data() || null) as any);
        setCommunityResolved(true);
      },
      () => {
        setCommunity(null);
        setCommunityResolved(true);
      }
    );
    return () => unsub();
  }, [user, profile?.communityId]);

  const loading = !authResolved || !profileResolved || !communityResolved;
  const value = useMemo(() => ({ user, profile, community, loading }), [user, profile, community, loading]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  return useContext(Ctx);
}
