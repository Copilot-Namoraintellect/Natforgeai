import { getDb } from "../queries/connection";
import { systemSettings } from "@db/schema";
import { eq } from "drizzle-orm";

export async function getSystemSetting(key: string, defaultValue?: string): Promise<string | undefined> {
  try {
    const db = getDb();
    const [row] = await db.select().from(systemSettings).where(eq(systemSettings.settingKey, key)).limit(1);
    return row?.settingValue ?? defaultValue;
  } catch (err) {
    console.error(`[SystemSettings] Failed to read ${key}:`, err);
    return defaultValue;
  }
}

export async function setSystemSetting(key: string, value: string, description?: string): Promise<void> {
  const db = getDb();
  await db
    .insert(systemSettings)
    .values({ settingKey: key, settingValue: value, description })
    .onDuplicateKeyUpdate({ set: { settingValue: value } });
}
