import { LegalPageLayout } from "@/components/LegalPageLayout";
import { useEffect } from "react";

export default function DataDeletion() {
  useEffect(() => {
    document.title = "Data Deletion Instructions | NatForgeAI";
  }, []);

  return (
    <LegalPageLayout title="Data Deletion Instructions" lastUpdated="23 June 2026">
      <p>
        NatForgeAI respects your right to control your data. This page explains how you can request
        deletion of your NatForgeAI account data and connected social integration data.
      </p>

      <h2>How to request deletion</h2>
      <p>
        To request deletion of your account and associated data, please send an email to{" "}
        <a href="mailto:admin@natforgeai.com">admin@natforgeai.com</a> with the following
        information:
      </p>
      <ul>
        <li>The email address associated with your NatForgeAI account.</li>
        <li>
          The type of deletion you are requesting:
          <ul>
            <li>Full account deletion (including all businesses, campaigns, and data).</li>
            <li>Deletion of a specific connected social integration and its synced data.</li>
            <li>Deletion of specific audience intelligence or engagement data.</li>
          </ul>
        </li>
        <li>Any additional details that will help us identify the data to delete.</li>
      </ul>

      <h2>What we delete</h2>
      <p>Depending on your request, NatForgeAI will remove the following where applicable:</p>
      <ul>
        <li>Your NatForgeAI account profile and authentication records.</li>
        <li>Businesses, campaigns, generated content, and workflow data you created.</li>
        <li>Connected social integration records and encrypted access tokens.</li>
        <li>Synced social profiles, engagement events, and audience interest signals.</li>
        <li>Lead scores, outreach recommendations, and related AI outputs.</li>
        <li>Billing and usage records beyond what we are required to retain for legal/tax purposes.</li>
      </ul>

      <h2>What we cannot delete</h2>
      <p>
        Deleting data within NatForgeAI does not automatically delete content you have already
        published to third-party platforms (such as Facebook, Instagram, or LinkedIn). You will need
        to remove that content directly on those platforms. We also retain limited information where
        required by law or for legitimate security, fraud-prevention, or audit purposes.
      </p>

      <h2>Timeframe</h2>
      <p>
        We will acknowledge your deletion request within 48 hours and complete the deletion within
        30 days, unless a longer period is required by law or technical constraints.
      </p>

      <h2>Contact</h2>
      <p>
        Send deletion requests to:{" "}
        <a href="mailto:admin@natforgeai.com">admin@natforgeai.com</a>
      </p>
    </LegalPageLayout>
  );
}
