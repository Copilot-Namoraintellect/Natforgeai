import { Link } from "react-router";
import { Logo } from "./Logo";
import { Mail } from "lucide-react";

interface LegalPageLayoutProps {
  title: string;
  lastUpdated?: string;
  children: React.ReactNode;
}

export function LegalPageLayout({ title, lastUpdated, children }: LegalPageLayoutProps) {
  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A]">
      <header className="border-b border-border/40 bg-white/70 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <Logo aria-label="NatForgeAI home" />
          <a
            href="mailto:admin@natforgeai.com"
            className="inline-flex items-center gap-2 text-sm font-medium text-[#0F172A]/80 hover:text-[#00D4FF] transition-colors"
          >
            <Mail className="w-4 h-4" />
            admin@natforgeai.com
          </a>
        </div>
      </header>

      <main className="max-w-[800px] mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-sm p-8 sm:p-12">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">{title}</h1>
          {lastUpdated && (
            <p className="text-sm text-[#64748B] mb-8">Last updated: {lastUpdated}</p>
          )}
          <div
            className="max-w-none text-[#334155]
            [&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-[#0F172A]
            [&_p]:mb-4 [&_p]:leading-7
            [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6
            [&_li]:mb-2
            [&_a]:text-[#00D4FF] [&_a]:hover:underline
            [&_strong]:font-semibold [&_strong]:text-[#0F172A]"
          >
            {children}
          </div>
        </div>
      </main>

      <footer className="border-t border-[#E2E8F0] bg-white py-8">
        <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-[#64748B]">
          <p>&copy; {new Date().getFullYear()} NatForgeAI. All rights reserved.</p>
          <div className="flex items-center gap-6">
            <Link to="/privacy" className="hover:text-[#0F172A] transition-colors">
              Privacy Policy
            </Link>
            <Link to="/terms" className="hover:text-[#0F172A] transition-colors">
              Terms of Service
            </Link>
            <Link to="/data-deletion" className="hover:text-[#0F172A] transition-colors">
              Data Deletion
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
