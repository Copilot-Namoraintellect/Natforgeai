import { LegalPageLayout } from "@/components/LegalPageLayout";
import { useEffect } from "react";

export default function Terms() {
  useEffect(() => {
    document.title = "Terms of Service | NatForgeAI";
  }, []);

  return (
    <LegalPageLayout title="Terms of Service" lastUpdated="23 June 2026">
      <p>
        These Terms of Service (“Terms”) govern your access to and use of NatForgeAI (“the
        Platform”). By creating an account or using the Platform, you agree to these Terms.
      </p>

      <h2>1. Acceptance of terms</h2>
      <p>
        You must be at least 18 years old and capable of entering into a binding agreement to use
        NatForgeAI. If you use the Platform on behalf of a business, you represent that you have
        authority to bind that business.
      </p>

      <h2>2. Account responsibility</h2>
      <p>
        You are responsible for maintaining the confidentiality of your login credentials and for
        all activity that occurs under your account. You agree to notify us immediately of any
        unauthorised access or security breach.
      </p>

      <h2>3. Acceptable use</h2>
      <p>You agree not to use NatForgeAI to:</p>
      <ul>
        <li>Violate any applicable law or regulation.</li>
        <li>Publish or promote illegal, fraudulent, defamatory, hateful, or harmful content.</li>
        <li>Scrape, abuse, or interfere with third-party platforms or APIs.</li>
        <li>Attempt to gain unauthorised access to the Platform or its infrastructure.</li>
        <li>Use the service in a way that materially degrades performance for other users.</li>
      </ul>

      <h2>4. AI-generated content</h2>
      <p>
        NatForgeAI uses artificial intelligence to generate campaigns, copy, creative briefs, and
        recommendations. You are responsible for reviewing, editing, and approving any content
        before publication. We do not guarantee that AI outputs are accurate, complete, or suitable
        for your specific use case.
      </p>

      <h2>5. Subscriptions and credits</h2>
      <p>
        Certain features require a paid subscription or consumption of credits. Fees are described
        on the Pricing page and are non-refundable unless otherwise required by law. We may change
        pricing with reasonable notice.
      </p>

      <h2>6. Integrations with third-party platforms</h2>
      <p>
        When you connect third-party accounts (such as Facebook, Instagram, or LinkedIn), you are
        also subject to those platforms’ terms and policies. NatForgeAI is not responsible for
        changes made by third-party platforms that affect functionality or data availability.
      </p>

      <h2>7. Intellectual property</h2>
      <p>
        You retain ownership of the content and data you provide. NatForgeAI retains ownership of
        the Platform, its software, and pre-existing materials. You receive a limited licence to use
        the Platform during your subscription term.
      </p>

      <h2>8. Termination</h2>
      <p>
        We may suspend or terminate your account if you violate these Terms or if required by law.
        You may cancel your account at any time by contacting{" "}
        <a href="mailto:admin@natforgeai.com">admin@natforgeai.com</a>.
      </p>

      <h2>9. Limitation of liability</h2>
      <p>
        To the fullest extent permitted by law, NatForgeAI and its affiliates will not be liable for
        any indirect, incidental, special, consequential, or punitive damages arising out of your use
        of the Platform. Our total liability for any claim shall not exceed the amount you paid us in
        the twelve months preceding the claim.
      </p>

      <h2>10. Changes to terms</h2>
      <p>
        We may update these Terms from time to time. Continued use of the Platform after changes
        constitutes acceptance of the revised Terms.
      </p>

      <h2>11. Contact us</h2>
      <p>
        For questions about these Terms, please contact{" "}
        <a href="mailto:admin@natforgeai.com">admin@natforgeai.com</a>.
      </p>
    </LegalPageLayout>
  );
}
