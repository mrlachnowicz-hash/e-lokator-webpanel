import { getFunctions, httpsCallable } from "firebase/functions";
import { app } from "./firebase";

export const functions = getFunctions(app, "europe-west1");

export function callable<TReq = any, TRes = any>(name: string) {
  return httpsCallable<TReq, TRes>(functions, name);
}
