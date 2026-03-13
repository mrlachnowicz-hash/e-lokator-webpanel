"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, User } from "firebase/auth";
import { collection, doc, getDoc, getDocs, limit, onSnapshot, query, where } from "firebase/firestore";
import { auth, db } from "./firebase";
import { isPanelEnabled } from "./panelAccess";

export type UserProfile = {
  role?: "OWNER" | "MASTER" | "ADMIN" | "ACCOUNTANT" | "RESIDENT" | "CONTRACTOR" | string;
  communityId?: string;
  customerId?: string;
  activeCommunityId?: string;
  currentCommunityId?: string;
  selectedCommunityId?: string;
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


function cleanId(value: unknown): string | undefined {
  const s = String(value ?? "").trim();
  return s ? s : undefined;
}

function normalizeUserProfile(raw: any): UserProfile | null {
  if (!raw) return null;
  const communityId = cleanId(raw.communityId) || cleanId(raw.customerId) || cleanId(raw.activeCommunityId) || cleanId(raw.currentCommunityId) || cleanId(raw.selectedCommunityId);
  return {
    ...raw,
    communityId,
    customerId: cleanId(raw.customerId),
    activeCommunityId: cleanId(raw.activeCommunityId),
    currentCommunityId: cleanId(raw.currentCommunityId),
    selectedCommunityId: cleanId(raw.selectedCommunityId),
    role: String(raw.role || "").toUpperCase() || undefined,
  } as UserProfile;
}

async function resolveCommunity(profile: UserProfile | null, user: User | null): Promise<CommunityProfile | null> {
  const candidates = Array.from(new Set([
    cleanId(profile?.communityId),
    cleanId(profile?.customerId),
    cleanId(profile?.activeCommunityId),
    cleanId(profile?.currentCommunityId),
    cleanId(profile?.selectedCommunityId),
  ].filter(Boolean) as string[]));

  for (const communityId of candidates) {
    try {
      const snap = await getDoc(doc(db, "communities", communityId));
      if (snap.exists()) {
        return { ...snap.data(), panelAccessEnabled: isPanelEnabled(snap.data()) } as CommunityProfile;
      }
    } catch {}

    try {
      const q = query(collection(db, "communities"), where("id", "==", communityId), limit(1));
      const qs = await getDocs(q);
      if (!qs.empty) return { ...qs.docs[0].data(), panelAccessEnabled: isPanelEnabled(qs.docs[0].data()) } as CommunityProfile;
    } catch {}
  }

  const email = String(user?.email || "").trim().toLowerCase();
  if (email) {
    for (const field of ["ownerEmail", "masterEmail", "email"]) {
      try {
        const q = query(collection(db, "communities"), where(field, "==", email), limit(1));
        const qs = await getDocs(q);
        if (!qs.empty) return { ...qs.docs[0].data(), panelAccessEnabled: isPanelEnabled(qs.docs[0].data()) } as CommunityProfile;
      } catch {}
    }
  }

  return null;
}

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
        const raw = (snap.data() || null) as any;
        const normalized = normalizeUserProfile(raw);
        setProfile(normalized);
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
    let cancelled = false;

    async function loadCommunity() {
      if (!user) {
        setCommunity(null);
        setCommunityResolved(true);
        return;
      }

      setCommunityResolved(false);
      const resolved = await resolveCommunity(profile, user);
      if (!cancelled) {
        setCommunity(resolved);
        setCommunityResolved(true);
      }
    }

    loadCommunity();
    return () => {
      cancelled = true;
    };
  }, [user, profile]);

  const loading = !authResolved || !profileResolved || !communityResolved;
  const value = useMemo(() => ({ user, profile, community, loading }), [user, profile, community, loading]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  return useContext(Ctx);
}
