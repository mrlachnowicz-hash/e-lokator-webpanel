import { NextRequest } from "next/server";
import { getAdminApp, getAdminDb } from "./firebaseAdmin";
import { isPanelEnabled } from "../panelAccess";

export class PanelAuthError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type RequestLike = Request | NextRequest;

type RequirePanelAccessOptions = {
  communityId?: string;
  roles?: string[];
  requirePanelAccess?: boolean;
};

function pickHeader(req: RequestLike, name: string): string {
  return req.headers.get(name) || "";
}

function safe(value: unknown): string {
  return String(value || "").trim();
}

export async function requirePanelAccess(req: RequestLike, options: RequirePanelAccessOptions = {}) {
  const authHeader = pickHeader(req, "authorization");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) {
    throw new PanelAuthError(401, "Brak tokenu autoryzacji.");
  }

  const adminApp = getAdminApp();
  const decoded = await adminApp.auth().verifyIdToken(token);
  const db = getAdminDb();
  const meSnap = await db.doc(`users/${decoded.uid}`).get();
  if (!meSnap.exists) {
    throw new PanelAuthError(403, "Nie znaleziono profilu użytkownika.");
  }

  const me = meSnap.data() || {};
  const role = safe((me as any).role).toUpperCase();
  const allowedRoles = (options.roles || ["MASTER", "ACCOUNTANT"]).map((x) => String(x).toUpperCase());
  if (allowedRoles.length && !allowedRoles.includes(role)) {
    throw new PanelAuthError(403, "Brak uprawnień do tej operacji.");
  }

  const communityId = safe(options.communityId || (me as any).communityId || (me as any).customerId);
  if (!communityId) {
    throw new PanelAuthError(400, "Brak communityId.");
  }

  const myCommunityId = safe((me as any).communityId || (me as any).customerId);
  if (myCommunityId && communityId !== myCommunityId) {
    throw new PanelAuthError(403, "communityId nie zgadza się z profilem użytkownika.");
  }

  if (options.requirePanelAccess !== false) {
    const communitySnap = await db.doc(`communities/${communityId}`).get();
    const panelEnabled = isPanelEnabled(communitySnap.data() || {});
    if (!panelEnabled) {
      throw new PanelAuthError(403, "Panel nie jest aktywny dla tej wspólnoty.");
    }
  }

  return { db, uid: decoded.uid, role, me, communityId };
}
