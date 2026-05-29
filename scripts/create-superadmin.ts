import "dotenv/config";
import { getDb } from "../api/queries/connection";
import { users, subscriptionTiers, subscriptions, userUsage } from "../db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { signLocalToken } from "../api/lib/session";

const SUPERADMIN_EMAIL = "superadministratorai@natforgeai.com";
const SUPERADMIN_USERNAME = "superadmin";
const SUPERADMIN_NAME = "Super Administrator";

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

  // Check if superadmin already exists
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, SUPERADMIN_EMAIL))
    .limit(1);

  if (existing) {
    console.log("Superadmin already exists:");
    console.log("  ID:", existing.id);
    console.log("  Email:", existing.email);
    console.log("  Role:", existing.role);
    console.log("  Name:", existing.name);

    if (existing.role !== "admin") {
      console.log("\nRole is not 'admin'. Promoting to admin...");
      await db.update(users).set({ role: "admin" }).where(eq(users.id, existing.id));
      console.log("Promoted to admin.");
    }

    console.log("\nNo password was changed. If you forgot the password, delete this user and re-run the script.");
    process.exit(0);
  }

  // Generate a secure random password
  const password = await generatePassword(16);
  const passwordHash = await bcrypt.hash(password, 12);

  // Create the superadmin user
  const [result] = await db.insert(users).values({
    username: SUPERADMIN_USERNAME,
    email: SUPERADMIN_EMAIL,
    passwordHash,
    name: SUPERADMIN_NAME,
    authType: "local",
    role: "admin",
    lastSignInAt: new Date(),
  });

  const userId = Number(result.insertId);

  // Assign free tier subscription
  const [freeTier] = await db
    .select()
    .from(subscriptionTiers)
    .where(eq(subscriptionTiers.slug, "free"))
    .limit(1);

  if (freeTier) {
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);
    await db.insert(subscriptions).values({
      userId,
      tierId: freeTier.id,
      status: "active",
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      paymentMethod: "manual",
    });
  }

  // Create usage tracking
  await db.insert(userUsage).values({
    userId,
    campaignsCreated: 0,
    successfulResults: 0,
  });

  // Generate a token for immediate use
  const token = await signLocalToken({ userId, type: "local" });

  console.log("============================================");
  console.log("  SUPERADMIN CREATED SUCCESSFULLY");
  console.log("============================================");
  console.log("");
  console.log("  Email:    ", SUPERADMIN_EMAIL);
  console.log("  Username: ", SUPERADMIN_USERNAME);
  console.log("  Password: ", password);
  console.log("  Role:     ", "admin");
  console.log("  User ID:  ", userId);
  console.log("");
  console.log("  Auth Token (for API testing):");
  console.log("  ", token);
  console.log("");
  console.log("============================================");
  console.log("");
  console.log("IMPORTANT: Save this password securely.");
  console.log("It will NOT be shown again.");
  console.log("");
  console.log("Login at: http://localhost:3000/login");
  console.log("Admin panel: http://localhost:3000/admin");
  console.log("");
  console.log("To change the password later, log in and");
  console.log("use the Settings page.");
  console.log("");

  process.exit(0);
}

main().catch((err) => {
  console.error("Failed to create superadmin:", err.message);
  process.exit(1);
});
