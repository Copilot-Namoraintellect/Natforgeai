import { getDb } from "../api/queries/connection";

async function main() {
  const db = getDb();

  // Create new tables for SaaS
  const tables = [
    `CREATE TABLE IF NOT EXISTS \`subscription_tiers\` (
      \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
      \`name\` varchar(100) NOT NULL,
      \`slug\` varchar(50) NOT NULL UNIQUE,
      \`description\` text,
      \`priceUsd\` int NOT NULL,
      \`billingCycle\` enum('monthly','yearly') NOT NULL DEFAULT 'monthly',
      \`maxCampaigns\` int DEFAULT 10,
      \`maxLeads\` int DEFAULT 100,
      \`maxContent\` int DEFAULT 50,
      \`maxAutomations\` int DEFAULT 3,
      \`aiGeneration\` boolean DEFAULT false,
      \`analytics\` boolean DEFAULT false,
      \`teamMembers\` int DEFAULT 1,
      \`features\` json,
      \`isActive\` boolean NOT NULL DEFAULT true,
      \`isDefault\` boolean DEFAULT false,
      \`displayOrder\` int DEFAULT 0,
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`)
    )`,
    `CREATE TABLE IF NOT EXISTS \`subscriptions\` (
      \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
      \`userId\` bigint unsigned NOT NULL,
      \`tierId\` bigint unsigned NOT NULL,
      \`status\` enum('active','trialing','past_due','cancelled','expired') NOT NULL DEFAULT 'trialing',
      \`trialEndsAt\` timestamp,
      \`currentPeriodStart\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`currentPeriodEnd\` timestamp,
      \`paymentMethod\` enum('stripe','paypal','bank_transfer','manual'),
      \`paymentReference\` varchar(255),
      \`cancelledAt\` timestamp,
      \`cancelAtPeriodEnd\` boolean DEFAULT false,
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`)
    )`,
    `CREATE TABLE IF NOT EXISTS \`user_usage\` (
      \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
      \`userId\` bigint unsigned NOT NULL UNIQUE,
      \`campaignsCreated\` int DEFAULT 0,
      \`successfulResults\` int DEFAULT 0,
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`)
    )`,
    `CREATE TABLE IF NOT EXISTS \`payments\` (
      \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
      \`userId\` bigint unsigned NOT NULL,
      \`subscriptionId\` bigint unsigned,
      \`amount\` int NOT NULL,
      \`currency\` varchar(3) NOT NULL DEFAULT 'USD',
      \`status\` enum('pending','completed','failed','refunded','disputed') NOT NULL DEFAULT 'pending',
      \`paymentMethod\` enum('stripe','paypal','bank_transfer','manual','crypto'),
      \`paymentReference\` varchar(255),
      \`description\` text,
      \`paidAt\` timestamp,
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`)
    )`,
    `CREATE TABLE IF NOT EXISTS \`banking_details\` (
      \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
      \`adminUserId\` bigint unsigned NOT NULL,
      \`accountName\` varchar(255),
      \`bankName\` varchar(255),
      \`accountNumber\` varchar(100),
      \`accountType\` enum('checking','savings','business') DEFAULT 'business',
      \`branchCode\` varchar(50),
      \`swiftCode\` varchar(50),
      \`iban\` varchar(100),
      \`routingNumber\` varchar(100),
      \`stripeAccountId\` varchar(255),
      \`paypalEmail\` varchar(320),
      \`cryptoWalletAddress\` varchar(255),
      \`cryptoNetwork\` varchar(50),
      \`isDefault\` boolean DEFAULT false,
      \`isActive\` boolean DEFAULT true,
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`)
    )`,
  ];

  for (const sql of tables) {
    try {
      await db.execute(sql);
      const tableName = sql.match(/CREATE TABLE IF NOT EXISTS `([^`]+)`/)?.[1];
      console.log(`Created ${tableName}`);
    } catch (e: any) {
      console.log(`Error creating table:`, e.message);
    }
  }

  // Add maxResults column to subscription_tiers if it doesn't exist
  try {
    await db.execute(`ALTER TABLE subscription_tiers ADD COLUMN maxResults int DEFAULT 5`);
    console.log("Added maxResults column to subscription_tiers");
  } catch (e: any) {
    if (e.message?.includes("Duplicate column")) {
      console.log("maxResults column already exists");
    } else {
      console.log("Error adding maxResults:", e.message);
    }
  }

  // Seed subscription tiers
  console.log("Seeding subscription tiers...");

  const tiers = [
    {
      name: "Free",
      slug: "free",
      description: "Get started with basic marketing tools. Perfect for individuals exploring the platform.",
      priceUsd: 0,
      billingCycle: "monthly" as const,
      maxCampaigns: 2,
      maxLeads: 20,
      maxContent: 10,
      maxAutomations: 0,
      maxResults: 5,
      aiGeneration: false,
      analytics: false,
      teamMembers: 1,
      features: JSON.stringify([
        "2 active campaigns",
        "5 successful results",
        "20 leads",
        "10 content pieces",
        "Basic content calendar",
        "Community support",
      ]),
      isActive: true,
      isDefault: true,
      displayOrder: 1,
    },
    {
      name: "Startup",
      slug: "startup",
      description: "Everything you need to launch and grow your business marketing. Our most popular plan.",
      priceUsd: 2000, // $20 in cents
      billingCycle: "monthly" as const,
      maxCampaigns: 10,
      maxLeads: 500,
      maxContent: 100,
      maxAutomations: 5,
      aiGeneration: true,
      analytics: true,
      teamMembers: 2,
      features: JSON.stringify([
        "10 active campaigns",
        "500 leads",
        "100 content pieces",
        "AI content generation",
        "Analytics dashboard",
        "5 automations",
        "2 team members",
        "Priority support",
      ]),
      isActive: true,
      isDefault: false,
      displayOrder: 2,
    },
    {
      name: "Growth",
      slug: "growth",
      description: "Scale your marketing with advanced tools, more capacity, and team collaboration.",
      priceUsd: 4900, // $49 in cents
      billingCycle: "monthly" as const,
      maxCampaigns: 50,
      maxLeads: 2000,
      maxContent: 500,
      maxAutomations: 20,
      aiGeneration: true,
      analytics: true,
      teamMembers: 5,
      features: JSON.stringify([
        "50 active campaigns",
        "2,000 leads",
        "500 content pieces",
        "AI content generation",
        "Advanced analytics",
        "20 automations",
        "5 team members",
        "Custom branding",
        "Priority support",
        "API access",
      ]),
      isActive: true,
      isDefault: false,
      displayOrder: 3,
    },
    {
      name: "Enterprise",
      slug: "enterprise",
      description: "Full-power marketing suite for large teams and agencies. Unlimited everything.",
      priceUsd: 9900, // $99 in cents
      billingCycle: "monthly" as const,
      maxCampaigns: 999,
      maxLeads: 99999,
      maxContent: 9999,
      maxAutomations: 999,
      aiGeneration: true,
      analytics: true,
      teamMembers: 20,
      features: JSON.stringify([
        "Unlimited campaigns",
        "Unlimited leads",
        "Unlimited content",
        "AI content generation",
        "Advanced analytics & reports",
        "Unlimited automations",
        "20 team members",
        "White-label branding",
        "Dedicated account manager",
        "API access",
        "Custom integrations",
        "SLA guarantee",
      ]),
      isActive: true,
      isDefault: false,
      displayOrder: 4,
    },
  ];

  for (const tier of tiers) {
    try {
      // Check if tier exists
      const existing = await db.execute(
        `SELECT id FROM subscription_tiers WHERE slug = '${tier.slug}'`
      );
      const rows = existing[0] as unknown as any[];
      if (!rows || rows.length === 0) {
        await db.execute(`
          INSERT INTO subscription_tiers 
          (name, slug, description, priceUsd, billingCycle, maxCampaigns, maxLeads, maxContent, maxAutomations, aiGeneration, analytics, teamMembers, features, isActive, isDefault, displayOrder)
          VALUES ('${tier.name}', '${tier.slug}', '${tier.description}', ${tier.priceUsd}, '${tier.billingCycle}', ${tier.maxCampaigns}, ${tier.maxLeads}, ${tier.maxContent}, ${tier.maxAutomations}, ${tier.aiGeneration}, ${tier.analytics}, ${tier.teamMembers}, '${tier.features}', ${tier.isActive}, ${tier.isDefault}, ${tier.displayOrder})
        `);
        console.log(`Created tier: ${tier.name}`);
      } else {
        console.log(`Tier already exists: ${tier.name}`);
      }
    } catch (e: any) {
      console.log(`Error seeding tier ${tier.name}:`, e.message);
    }
  }

  console.log("Done!");
  process.exit(0);
}

main();
