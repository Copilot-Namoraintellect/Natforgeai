import { localAuthRouter } from "./local-auth-router";
import { businessRouter } from "./business-router";
import { campaignRouter } from "./campaign-router";
import { contentRouter } from "./content-router";
import { leadRouter } from "./lead-router";
import { scheduleRouter } from "./schedule-router";
import { automationRouter } from "./automation-router";
import { analyticsRouter } from "./analytics-router";
import { templateRouter } from "./template-router";
import { imageRouter } from "./image-router";
import { subscriptionRouter } from "./subscription-router";
import { adminRouter } from "./admin-router";
import { bankingRouter } from "./banking-router";
import { createRouter, publicQuery } from "./middleware";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  firebaseStatus: publicQuery.query(async () => {
    try {
      const { firebaseAuth } = await import("./lib/firebase-admin");
      const result = await firebaseAuth.listUsers(1);
      return {
        status: "ok",
        projectId: "ai-marketing-tool-nxtz",
        adminSdkInitialized: true,
        apiReachable: true,
        usersInProject: result.users.length,
      };
    } catch (err: any) {
      return {
        status: "error",
        error: err.message,
        code: err.code || "unknown",
      };
    }
  }),
  auth: localAuthRouter,
  business: businessRouter,
  campaign: campaignRouter,
  content: contentRouter,
  lead: leadRouter,
  schedule: scheduleRouter,
  automation: automationRouter,
  analytics: analyticsRouter,
  template: templateRouter,
  image: imageRouter,
  subscription: subscriptionRouter,
  admin: adminRouter,
  banking: bankingRouter,
});

export type AppRouter = typeof appRouter;
