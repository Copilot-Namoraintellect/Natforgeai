import { Link } from "react-router";
import { cn } from "@/lib/utils";

interface LogoProps {
  className?: string;
  showText?: boolean;
  size?: "sm" | "md" | "lg";
  dark?: boolean;
  to?: string;
}

export function Logo({ className, showText = true, size = "md", dark = false, to = "/" }: LogoProps) {
  const sizes = { sm: 24, md: 32, lg: 40 };
  const s = sizes[size];

  return (
    <Link to={to} className={cn("flex items-center gap-2.5", className)}>
      <svg
        width={s}
        height={s}
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="shrink-0"
      >
        <defs>
          <linearGradient id="natforge-gradient" x1="3.5" y1="2" x2="36.5" y2="40" gradientUnits="userSpaceOnUse">
            <stop stopColor="#00D4FF" />
            <stop offset="1" stopColor="#7C3AED" />
          </linearGradient>
        </defs>
        <path d="M20 2L36.5 11.5V30.5L20 40L3.5 30.5V11.5L20 2Z" fill="url(#natforge-gradient)" />
        <path
          d="M12 12L20 20L28 12V28L20 20L12 28V12Z"
          stroke="white"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="10" cy="20" r="1.5" fill="white" />
        <path d="M10 20V26" stroke="white" strokeWidth="1" strokeLinecap="round" />
        <circle cx="10" cy="26" r="1" fill="white" />
      </svg>
      {showText && (
        <span className="font-bold text-lg tracking-tight whitespace-nowrap">
          <span className={dark ? "text-white" : "text-[#0F172A]"}>NatForge</span>
          <span className="bg-gradient-to-r from-[#00D4FF] to-[#7C3AED] bg-clip-text text-transparent">AI</span>
        </span>
      )}
    </Link>
  );
}
