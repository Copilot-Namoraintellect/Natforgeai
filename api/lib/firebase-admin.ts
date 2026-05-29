import admin from "firebase-admin";
import { getApps } from "firebase-admin/app";
import { env } from "./env";
import fs from "fs";

function loadServiceAccount(): admin.ServiceAccount {
  try {
    return JSON.parse(env.firebaseServiceAccount) as admin.ServiceAccount;
  } catch {
    return JSON.parse(
      fs.readFileSync(env.firebaseServiceAccount, "utf-8")
    ) as admin.ServiceAccount;
  }
}

if (!getApps().length) {
  admin.initializeApp({
    credential: admin.credential.cert(loadServiceAccount()),
  });
}

export const firebaseAuth = admin.auth();
