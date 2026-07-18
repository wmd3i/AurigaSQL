import type { SVGProps } from "react";

export function AurigaMascotIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 64 64" role="img" aria-hidden="true" {...props}>
      <defs>
        <linearGradient id="auriga-mascot-teal" x1="10" x2="39" y1="13" y2="43" gradientUnits="userSpaceOnUse">
          <stop stopColor="#3ee2de" />
          <stop offset="1" stopColor="#087b73" />
        </linearGradient>
        <linearGradient id="auriga-mascot-blue" x1="49" x2="62" y1="21" y2="34" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7085ff" />
          <stop offset="1" stopColor="#2850df" />
        </linearGradient>
        <linearGradient id="auriga-mascot-ice" x1="20" x2="47" y1="23" y2="48" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffffff" />
          <stop offset="1" stopColor="#eef2f3" />
        </linearGradient>
        <linearGradient id="auriga-mascot-cell" x1="24" x2="47" y1="24" y2="48" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f3f6f7" />
          <stop offset="1" stopColor="#cdd4d8" />
        </linearGradient>
        <filter id="auriga-mascot-shadow" x="-20%" y="-20%" width="140%" height="150%" colorInterpolationFilters="sRGB">
          <feDropShadow dx="0" dy="3" stdDeviation="2.5" floodColor="#18201c" floodOpacity="0.18" />
        </filter>
      </defs>

      <path d="M19 30H11" stroke="#141d1b" strokeWidth="5" strokeLinecap="round" />
      <path d="M45 30H53" stroke="#141d1b" strokeWidth="5" strokeLinecap="round" />
      <path d="M29 46C29 52 24 52 23 57" stroke="#141d1b" strokeWidth="5" strokeLinecap="round" />
      <path d="M38 46C38 52 44 52 44 57" stroke="#141d1b" strokeWidth="5" strokeLinecap="round" />

      <rect x="5" y="18" width="14" height="14" rx="4" fill="url(#auriga-mascot-teal)" filter="url(#auriga-mascot-shadow)" />
      <rect
        x="50"
        y="20"
        width="12"
        height="12"
        rx="3"
        fill="url(#auriga-mascot-blue)"
        filter="url(#auriga-mascot-shadow)"
        transform="rotate(45 56 26)"
      />
      <circle cx="22" cy="57" r="5.5" fill="url(#auriga-mascot-teal)" filter="url(#auriga-mascot-shadow)" />
      <rect x="40" y="52" width="10" height="10" rx="3" fill="#d8dee2" filter="url(#auriga-mascot-shadow)" />

      <rect x="20" y="5" width="24" height="15" rx="8" fill="#ffffff" filter="url(#auriga-mascot-shadow)" />
      <rect x="23" y="8" width="18" height="9" rx="5" fill="#141d1b" />
      <circle cx="29" cy="12.5" r="1.8" fill="#49e4df" />
      <circle cx="36" cy="12.5" r="1.8" fill="#49e4df" />
      <path d="M32 20V24" stroke="#141d1b" strokeWidth="3" strokeLinecap="round" />

      <rect x="16" y="23" width="32" height="25" rx="7" fill="url(#auriga-mascot-ice)" filter="url(#auriga-mascot-shadow)" />
      <rect x="20" y="27" width="8" height="6" rx="1.2" fill="url(#auriga-mascot-teal)" />
      <rect x="30" y="27" width="7.5" height="6" rx="1.2" fill="url(#auriga-mascot-cell)" />
      <rect x="39.5" y="27" width="7" height="6" rx="1.2" fill="url(#auriga-mascot-cell)" />
      <rect x="20" y="35" width="8" height="5.5" rx="1.2" fill="url(#auriga-mascot-cell)" />
      <rect x="30" y="35" width="7.5" height="5.5" rx="1.2" fill="url(#auriga-mascot-cell)" />
      <rect x="39.5" y="35" width="7" height="5.5" rx="1.2" fill="url(#auriga-mascot-cell)" />
      <rect x="20" y="42.5" width="8" height="4" rx="1.2" fill="url(#auriga-mascot-cell)" />
      <rect x="30" y="42.5" width="7.5" height="4" rx="1.2" fill="url(#auriga-mascot-cell)" />
      <rect x="39.5" y="42.5" width="7" height="4" rx="1.2" fill="url(#auriga-mascot-cell)" />
    </svg>
  );
}
