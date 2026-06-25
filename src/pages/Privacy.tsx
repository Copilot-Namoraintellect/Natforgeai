import { LegalPageLayout } from "@/components/LegalPageLayout";
import { useEffect } from "react";

export default function Privacy() {
  useEffect(() => {
    document.title = "Privacy Policy | NatForgeAI";
  }, []);

  return (
    <LegalPageLayout title="Privacy Policy" lastUpdated="23 June 2026">
      <p>
        NatForgeAI (“we”, “us”, or “our”) is committed to protecting your privacy. This Privacy
        Policy explains how we collect, use, store, and protect your information when you use our
        platform at <a href="https://natforgeai.com">natforgeai.com</a>.
      </p>

      <h2>1. Information we collect</h2>
      <ul>
        <li>
          <strong>Account information:</strong> name, email address, and authentication credentials
          used to create and secure your NatForgeAI account.
        </li>
        <li>
          <strong>Business information:</strong> business name, industry, location, website, brand
          details, and marketing goals that you provide to generate campaigns.
        </li>
        <li>
          <strong>Social integration data:</strong> when you connect Facebook, Instagram, LinkedIn,
          or other supported platforms, we receive profile/page identifiers and access tokens
          required to read engagement data on your behalf. We do not store platform passwords.
        </li>
        <li>
          <strong>Usage and AI output:</strong> campaigns, content, prompts, agent outputs, credit
          usage, and system logs that help us operate and improve the service.
        </li>
        <li>
          <strong>Cookies and analytics:</strong> standard cookies and analytics data to maintain
          sessions and understand product usage.
        </li>
      </ul>

      <h2>2. How we use your information</h2>
      <ul>
        <li>Provide, operate, and improve the NatForgeAI marketing platform and AI agents.</li>
        <li>Generate, publish, and optimise campaigns based on your business inputs.</li>
        <li>Read permissioned engagement data from connected social accounts for Audience Intelligence.</li>
        <li>Process subscriptions, credits, billing, and customer support requests.</li>
        <li>Maintain security, prevent fraud, and comply with legal obligations.</li>
      </ul>

      <h2>3. Social integrations and third-party platforms</h2>
      <p>
        Connecting a social account is optional. When you connect an account, you authorise
        NatForgeAI to access only the data and permissions you grant. We use official APIs, do not
        scrape data, and respect the terms of each platform. You can disconnect an integration at
        any time from the Integrations page.
      </p>

      <h2>4. How we protect your data</h2>
      <ul>
        <li>Social access tokens are encrypted at rest and transmitted securely.</li>
        <li>Access to production systems is restricted and protected by multi-factor authentication.</li>
        <li>We do not sell your personal information to third parties.</li>
        <li>We only share data with service providers necessary to operate the platform, under strict confidentiality obligations.</li>
      </ul>

      <h2>5. Data retention and deletion</h2>
      <p>
        We retain your data for as long as your account is active or as needed to provide the
        service and comply with legal obligations. You can request deletion of your account and
        associated data at any time by following the instructions on our{" "}
        <a href="/data-deletion">Data Deletion</a> page or emailing{" "}
        <a href="mailto:admin@natforgeai.com">admin@natforgeai.com</a>.
      </p>

      <h2>6. Your rights</h2>
      <p>
        Depending on your jurisdiction, you may have the right to access, correct, export, or
        delete your personal information. To exercise these rights, contact us at{" "}
        <a href="mailto:admin@natforgeai.com">admin@natforgeai.com</a>.
      </p>

      <h2>7. Contact us</h2>
      <p>
        If you have any questions about this Privacy Policy, please contact us at{" "}
        <a href="mailto:admin@natforgeai.com">admin@natforgeai.com</a>.
      </p>
    </LegalPageLayout>
  );
}
