import "dotenv/config";
import { getDb } from "../api/queries/connection";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { signLocalToken } from "../api/lib/session";

const SUPERADMIN_EMAIL = "superadministratorai@natforgeai.com";

async function generatePassword(length = 16): Promise<string> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  let pass = "";
  for (let i = 0; i < length; i++) {
    pass += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pass;
}

async function main() {
  const db = getDb();

  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, SUPERADMIN_EMAIL))
    .limit(1);

  if (!existing) {
    console.log("Superadmin not found. Run: npm run create:superadmin");
    process.exit(1);
  }

  const password = await generatePassword(16);
  const passwordHash = await bcrypt.hash(password, 12);

  await db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.id, existing.id));

  const token = await signLocalToken({ userId: existing.id, type: "local" });

  console.log("============================================");
  console.log("  SUPERADMIN PASSWORD RESET");
  console.log("============================================");
  console.log("");
  console.log("  Email:    ", SUPERADMIN_EMAIL);
  console.log("  Username: ", existing.username);
  console.log("  Name:     ", existing.name);
  console.log("  Role:     ", existing.role);
  console.log("  User ID:  ", existing.id);
  console.log("");
  console.log("  NEW Password: ", password);
  console.log("");
  console.log("  Auth Token:");
  console.log("  ", token);
  console.log("");
  console.log("============================================");
  console.log("");
  console.log("IMPORTANT: Save this password securely.");
  console.log("It will NOT be shown again.");
  console.log("");

  process.exit(0);
}

main().catch((err) => {
  console.error("Failed to reset password:", err.message);
  process.exit(1);
});
