import * as React from "react";
import { cn } from "@/lib/cn";

type IconProps = React.SVGProps<SVGSVGElement> & {
  name: IconName;
  size?: number;
  strokeWidth?: number;
};

export type IconName =
  | "home" | "users" | "chart" | "spark" | "clock" | "inbox"
  | "bars" | "settings" | "search" | "send" | "mail" | "star"
  | "check" | "info" | "money" | "filter" | "arrow-right" | "plus"
  | "chevron-down" | "chat" | "agents-grid" | "build" | "globe"
  | "doc" | "stamp" | "burst"
  // Sidebar-friendly nav glyphs (added so labels and shapes match)
  | "message-square" | "user-plus" | "graduation-cap" | "pipeline"
  | "life-ring" | "calendar" | "tag" | "robot"
  | "batches"
  // Voice / Exotel
  | "phone";

export function Icon({ name, size = 16, strokeWidth = 1.7, className, ...rest }: IconProps) {
  const props = {
    width: size, height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: cn(className),
    ...rest,
  };
  switch (name) {
    case "home":
      return (<svg {...props}><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" /><path d="M9 22V12h6v10" /></svg>);
    case "users":
      return (<svg {...props}><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" /></svg>);
    case "chart":
      return (<svg {...props}><path d="M3 3v18h18" /><path d="M7 14l4-4 3 3 5-6" /></svg>);
    case "spark":
      return (<svg {...props}><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" /></svg>);
    case "clock":
      return (<svg {...props}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>);
    case "phone":
      // Handset glyph — Lucide's "phone" path. Slight rotation so the
      // handset reads as "off-hook" (active) rather than "hung up".
      return (<svg {...props}><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.96.37 1.9.72 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0122 16.92z" /></svg>);
    case "inbox":
      return (<svg {...props}><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>);
    case "bars":
      return (<svg {...props}><path d="M3 3v18h18" /><rect x="7" y="11" width="3" height="6" /><rect x="12" y="7" width="3" height="10" /><rect x="17" y="4" width="3" height="13" /></svg>);
    case "settings":
      return (<svg {...props}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.6 1.6 0 008 19.4a1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H2a2 2 0 110-4h.1A1.6 1.6 0 004.6 8a1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V2a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H22a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z" /></svg>);
    case "search":
      return (<svg {...props}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" /></svg>);
    case "send":
      return (<svg {...props}><path d="M4 4h16v12H5.2L4 20z" /></svg>);
    case "mail":
      return (<svg {...props}><path d="M4 4h16v12H5.2L4 20z" /></svg>);
    case "star":
      return (<svg {...props}><path d="M12 2l2 7h7l-5.5 4 2 7L12 16l-5.5 4 2-7L3 9h7z" /></svg>);
    case "check":
      return (<svg {...props}><path d="M20 6L9 17l-5-5" /></svg>);
    case "info":
      return (<svg {...props}><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>);
    case "money":
      return (<svg {...props}><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" /></svg>);
    case "filter":
      return (<svg {...props}><path d="M4 6h16M7 12h10M10 18h4" /></svg>);
    case "arrow-right":
      return (<svg {...props}><path d="M5 12h14M13 6l6 6-6 6" /></svg>);
    case "plus":
      return (<svg {...props}><path d="M12 5v14M5 12h14" /></svg>);
    case "chevron-down":
      return (<svg {...props}><path d="M6 9l6 6 6-6" /></svg>);
    case "chat":
      return (<svg {...props}><path d="M8 10h8M8 14h5M21 12a8 8 0 01-11.5 7.2L4 21l1.8-5.5A8 8 0 1121 12z" /></svg>);
    case "agents-grid":
      return (<svg {...props}><path d="M4 6h4M4 12h4M4 18h4M11 6h9M11 12h9M11 18h9" /></svg>);
    case "build":
      return (<svg {...props}><path d="M9 6l-5 6 5 6M15 6l5 6-5 6" /></svg>);
    case "globe":
      return (<svg {...props}><circle cx="12" cy="12" r="9" /><path d="M2 12h20M12 3a15 15 0 010 18M12 3a15 15 0 000 18" /></svg>);
    case "doc":
      return (<svg {...props}><rect x="4" y="2" width="16" height="20" rx="2" /><path d="M9 7h6M9 11h6M9 15h4" /></svg>);
    case "stamp":
      return (<svg {...props}><path d="M11 20A7 7 0 019 6c4-2 8-1 11-3 1 5-1 12-9 14z" /><path d="M2 22c4-6 7-8 12-9" /></svg>);
    case "burst":
      return (
        <svg {...props}>
          <defs>
            <linearGradient id="burst-bg" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
              <stop stopColor="#1F3FCF" />
              <stop offset=".5" stopColor="#6B1FB8" />
              <stop offset="1" stopColor="#C7197A" />
            </linearGradient>
          </defs>
          <g stroke="url(#burst-bg)" strokeWidth="2.4">
            <path d="M12 2v6M12 16v6M2 12h6M16 12h6M5 5l4 4M15 15l4 4M19 5l-4 4M9 15l-4 4" />
          </g>
        </svg>
      );
    case "message-square":
      // Square chat bubble — Inbox / messaging
      return (<svg {...props}><path d="M21 15a2 2 0 01-2 2H8l-5 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>);
    case "user-plus":
      // Person silhouette with a '+' — Leads (new people coming in)
      return (<svg {...props}><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="8.5" cy="7" r="4" /><path d="M20 8v6M23 11h-6" /></svg>);
    case "graduation-cap":
      // Mortarboard — Learners
      return (<svg {...props}><path d="M22 10L12 5 2 10l10 5 10-5z" /><path d="M6 12v5a6 6 0 0012 0v-5" /></svg>);
    case "pipeline":
      // Kanban-style 3-column board — Pipeline
      return (<svg {...props}><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="9.5" y="4" width="5" height="11" rx="1" /><rect x="16" y="4" width="5" height="7" rx="1" /></svg>);
    case "life-ring":
      // Life-buoy — Cases / support
      return (<svg {...props}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.5" /><path d="M4.93 4.93l4.62 4.62M14.45 14.45l4.62 4.62M19.07 4.93l-4.62 4.62M9.55 14.45l-4.62 4.62" /></svg>);
    case "calendar":
      // Calendar grid — Calendar
      return (<svg {...props}><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></svg>);
    case "tag":
      // Pricing/tag glyph — Tags
      return (<svg {...props}><path d="M20.6 13.4L13 21l-9-9V4h8z" /><circle cx="8" cy="8" r="1.5" /></svg>);
    case "robot":
      // Bot face — AI agents
      return (<svg {...props}><rect x="4" y="7" width="16" height="13" rx="3" /><circle cx="9" cy="13.5" r="1.2" /><circle cx="15" cy="13.5" r="1.2" /><path d="M12 4v3M9 17h6" /></svg>);
    case "batches":
      // Stacked layers / cohorts — Batches (separate from Calendar so the
      // sidebar doesn't show two identical calendar glyphs).
      return (
        <svg {...props}>
          <path d="M12 3l9 4.5-9 4.5-9-4.5z" />
          <path d="M3 12l9 4.5 9-4.5" />
          <path d="M3 16.5l9 4.5 9-4.5" />
        </svg>
      );
  }
}
