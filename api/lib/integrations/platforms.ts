import { env } from "../env";
import type { OAuthConfig } from "./oauth";
import { createTransport } from "nodemailer";

// Platform OAuth configurations
// NOTE: Client IDs and secrets should be set via environment variables

export const platformConfigs: Record<string, OAuthConfig> = {
  facebook: {
    authorizeUrl: "https://www.facebook.com/v18.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v18.0/oauth/access_token",
    scopes: ["pages_manage_posts", "pages_read_engagement", "pages_messaging"],
    clientId: process.env.FACEBOOK_APP_ID || "",
    clientSecret: process.env.FACEBOOK_APP_SECRET || "",
  },
  instagram: {
    authorizeUrl: "https://www.facebook.com/v18.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v18.0/oauth/access_token",
    scopes: ["instagram_basic", "instagram_content_publish", "instagram_manage_messages"],
    clientId: process.env.FACEBOOK_APP_ID || "",
    clientSecret: process.env.FACEBOOK_APP_SECRET || "",
  },
  linkedin: {
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["w_member_social", "r_basicprofile", "r_organization_social", "w_organization_social"],
    clientId: process.env.LINKEDIN_CLIENT_ID || "",
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET || "",
  },
  twitter: {
    authorizeUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.twitter.com/2/oauth2/token",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    clientId: process.env.TWITTER_CLIENT_ID || "",
    clientSecret: process.env.TWITTER_CLIENT_SECRET || "",
    additionalParams: {
      code_challenge_method: "S256",
      code_challenge: "challenge", // In production, generate PKCE
    },
  },
  tiktok: {
    authorizeUrl: "https://www.tiktok.com/v2/auth/authorize",
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token",
    scopes: ["video.publish", "video.upload"],
    clientId: process.env.TIKTOK_CLIENT_KEY || "",
    clientSecret: process.env.TIKTOK_CLIENT_SECRET || "",
  },
};

// Publishing interfaces
export interface PublishPayload {
  text: string;
  mediaUrls?: string[];
  mediaType?: "image" | "video";
}

export interface PublishResult {
  success: boolean;
  postId?: string;
  url?: string;
  error?: string;
}

// Facebook/Meta publishing
export async function publishToFacebook(
  accessToken: string,
  pageId: string,
  payload: PublishPayload
): Promise<PublishResult> {
  try {
    const url = `https://graph.facebook.com/v18.0/${pageId}/feed`;
    const params = new URLSearchParams({
      access_token: accessToken,
      message: payload.text,
    });

    const response = await fetch(`${url}?${params.toString()}`, {
      method: "POST",
    });

    const data = await response.json() as any;

    if (data.error) {
      return { success: false, error: data.error.message };
    }

    return {
      success: true,
      postId: data.id,
      url: `https://facebook.com/${data.id}`,
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Instagram publishing (via Facebook Graph API)
export async function publishToInstagram(
  accessToken: string,
  instagramAccountId: string,
  payload: PublishPayload
): Promise<PublishResult> {
  try {
    // Step 1: Create media container
    const containerUrl = `https://graph.facebook.com/v18.0/${instagramAccountId}/media`;
    const containerParams = new URLSearchParams({
      access_token: accessToken,
      caption: payload.text,
    });

    if (payload.mediaUrls && payload.mediaUrls.length > 0) {
      containerParams.append("image_url", payload.mediaUrls[0]);
    }

    const containerResponse = await fetch(`${containerUrl}?${containerParams.toString()}`, {
      method: "POST",
    });

    const containerData = await containerResponse.json() as any;

    if (containerData.error) {
      return { success: false, error: containerData.error.message };
    }

    // Step 2: Publish the container
    const publishUrl = `https://graph.facebook.com/v18.0/${instagramAccountId}/media_publish`;
    const publishParams = new URLSearchParams({
      access_token: accessToken,
      creation_id: containerData.id,
    });

    const publishResponse = await fetch(`${publishUrl}?${publishParams.toString()}`, {
      method: "POST",
    });

    const publishData = await publishResponse.json() as any;

    if (publishData.error) {
      return { success: false, error: publishData.error.message };
    }

    return {
      success: true,
      postId: publishData.id,
      url: `https://instagram.com/p/${publishData.id}`,
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// LinkedIn publishing
export async function publishToLinkedIn(
  accessToken: string,
  organizationId: string,
  payload: PublishPayload
): Promise<PublishResult> {
  try {
    const response = await fetch("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        author: `urn:li:organization:${organizationId}`,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: {
              text: payload.text,
            },
            shareMediaCategory: "NONE",
          },
        },
        visibility: {
          "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error };
    }

    const data = await response.json() as any;
    return {
      success: true,
      postId: data.id,
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Twitter/X publishing
export async function publishToTwitter(
  accessToken: string,
  payload: PublishPayload
): Promise<PublishResult> {
  try {
    const response = await fetch("https://api.twitter.com/2/tweets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: payload.text,
      }),
    });

    const data = await response.json() as any;

    if (data.errors) {
      return { success: false, error: data.errors[0].message };
    }

    return {
      success: true,
      postId: data.data.id,
      url: `https://twitter.com/i/web/status/${data.data.id}`,
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// TikTok publishing (stub - requires more complex video upload flow)
export async function publishToTikTok(
  _accessToken: string,
  _payload: PublishPayload
): Promise<PublishResult> {
  // TikTok publishing requires video upload which is more complex
  // This is a simplified stub
  return {
    success: false,
    error: "TikTok publishing requires video upload. Use the TikTok app for now.",
  };
}

// WhatsApp Business API (via Meta Business API)
export async function sendWhatsAppMessage(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  message: string
): Promise<PublishResult> {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { body: message },
        }),
      }
    );

    const data = await response.json() as any;

    if (data.error) {
      return { success: false, error: data.error.message };
    }

    return {
      success: true,
      postId: data.messages?.[0]?.id,
    };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Email sending (via SMTP or SendGrid)
export async function sendEmail(
  config: {
    smtpHost?: string;
    smtpPort?: number;
    smtpUser?: string;
    smtpPass?: string;
    apiKey?: string;
    fromEmail: string;
    fromName: string;
  },
  to: string,
  subject: string,
  body: string
): Promise<PublishResult> {
  // Prefer SendGrid if API key is configured
  if (env.sendgridApiKey && env.sendgridApiKey.length > 0) {
    try {
      const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.sendgridApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: config.fromEmail, name: config.fromName },
          subject,
          content: [{ type: "text/plain", value: body }],
        }),
      });

      if (response.ok || response.status === 202) {
        return { success: true, postId: `email_${Date.now()}` };
      }
      const errText = await response.text();
      return { success: false, error: `SendGrid error: ${errText}` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // Fall back to SMTP via nodemailer
  const smtpHost = config.smtpHost || env.smtpHost;
  const smtpPort = config.smtpPort || env.smtpPort;
  const smtpUser = config.smtpUser || env.smtpUser;
  const smtpPass = config.smtpPass || env.smtpPass;

  if (!smtpHost || !smtpUser || !smtpPass) {
    return {
      success: false,
      error: "Email provider not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS or SENDGRID_API_KEY.",
    };
  }

  try {
    const transporter = createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });

    const info = await transporter.sendMail({
      from: `"${config.fromName}" <${config.fromEmail}>`,
      to,
      subject,
      text: body,
    });

    return { success: true, postId: info.messageId || `email_${Date.now()}` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// Platform-specific account info fetching
export async function getFacebookPages(accessToken: string) {
  const response = await fetch(
    `https://graph.facebook.com/v18.0/me/accounts?access_token=${accessToken}`
  );
  const data = await response.json() as any;
  return data.data || [];
}

export async function getInstagramAccounts(accessToken: string, pageId: string) {
  const response = await fetch(
    `https://graph.facebook.com/v18.0/${pageId}?fields=instagram_business_account&access_token=${accessToken}`
  );
  const data = await response.json() as any;
  return data.instagram_business_account;
}

export async function getLinkedInProfile(accessToken: string): Promise<any> {
  const response = await fetch("https://api.linkedin.com/v2/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return response.json();
}

export async function getTwitterProfile(accessToken: string): Promise<any> {
  const response = await fetch("https://api.twitter.com/2/users/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return response.json();
}
