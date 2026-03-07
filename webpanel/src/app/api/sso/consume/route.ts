import { NextResponse } from "next/server";
import * as admin from "firebase-admin";

// firebase-admin is Node-only (not Edge). Force Node runtime for this route.
export const runtime = "nodejs";

function initAdmin() {
  if (admin.apps.length) return admin.app();
  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Missing Firebase Admin env (FIREBASE_ADMIN_*)");
  }

  // Support \n in env
  privateKey = privateKey.replace(/\\n/g, "\n");

  return admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

export async function POST(req: Request) {
  try {
    initAdmin();
    const { token } = await req.json();
    if (!token) return new NextResponse("Missing token", { status: 400 });

    const db = admin.firestore();
    const ref = db.doc(`webSessions/${token}`);

    const out = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("Token not found");
      const s: any = snap.data();
      if (s.used) throw new Error("Token already used");
      if (Date.now() > Number(s.expiresAtMs || 0)) throw new Error("Token expired");
      tx.update(ref, { used: true, usedAtMs: Date.now() });
      const customToken = await admin.auth().createCustomToken(String(s.uid));
      return { customToken, target: s.target || "/payments" };
    });

    return NextResponse.json(out);
  } catch (e: any) {
    return new NextResponse(e?.message || "SSO error", { status: 500 });
  }
}
