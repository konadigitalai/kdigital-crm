"use client";

// Auto-linkify message bodies for the inbox — URLs, emails, and phone
// numbers become clickable, WhatsApp-style. Regex-based (no DOM parser)
// so this is safe against XSS: we build a React tree, never innerHTML.
//
// Rules:
//   - URLs with http(s):// or www.  → <a target="_blank" rel="noreferrer">
//     - hostname stays visible; long paths are truncated in display but
//       the href stays full.
//   - Bare domains like "digitaledify.ai" are LEFT AS TEXT — the false-
//     positive rate is too high (e.g. "test.something you'll see").
//   - Emails → <a href="mailto:">
//   - +E.164 phone numbers or 10+ digit runs → <a href="tel:">
//
// Ordering matters — email pattern eats "@" first so URLs like foo@bar.com
// don't get mis-treated as bar.com. The combined regex uses alternation
// with named parts so we can key each match by kind.

import type { ReactNode } from "react";

// One regex to rule them all: URL | email | phone.
// Kept as three top-level alternatives in a single expression so
// String.split doesn't get confused about ordering.
const LINK_RE = new RegExp(
  // group 1: URL (http/https/www)
  '(https?:\\/\\/[^\\s<>()"\']+|www\\.[^\\s<>()"\']+)'
  + '|'
  // group 2: email
  + '([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,})'
  + '|'
  // group 3: phone — +E.164 or a bare 10-15 digit run bounded by non-digit
  + '(\\+\\d[\\d\\s\\-\\.\\(\\)]{7,}\\d|(?:^|(?<=[^\\d]))\\d{10,15}(?=[^\\d]|$))',
  "g",
);

/** Render a message body with URLs / emails / phones as anchors. */
export function linkify(text: string, outbound: boolean): ReactNode[] {
  if (!text) return [];
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  // Reset lastIndex — the RegExp is `g` and holds state across calls.
  LINK_RE.lastIndex = 0;
  let n = 0;
  while ((match = LINK_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      out.push(text.slice(lastIndex, match.index));
    }
    const [full, url, email, phone] = match;
    n += 1;
    if (url) {
      const href = url.startsWith("www.") ? `https://${url}` : url;
      out.push(<Anchor key={`u${n}`} href={href} label={truncateForDisplay(url)} outbound={outbound} />);
    } else if (email) {
      out.push(<Anchor key={`e${n}`} href={`mailto:${email}`} label={email} outbound={outbound} />);
    } else if (phone) {
      const digits = phone.replace(/[^\d+]/g, "");
      out.push(<Anchor key={`p${n}`} href={`tel:${digits}`} label={phone.trim()} outbound={outbound} />);
    } else {
      out.push(full);
    }
    lastIndex = LINK_RE.lastIndex;
  }
  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out;
}

function truncateForDisplay(url: string): string {
  // Trim a trailing punctuation that got included in the match ("check foo.com,")
  const stripped = url.replace(/[.,;:!?)\]}]+$/, "");
  // Cap display at 48 chars — full URL still opens on click via href.
  if (stripped.length <= 48) return stripped;
  return stripped.slice(0, 45) + "…";
}

function Anchor({
  href, label, outbound,
}: {
  href: string;
  label: string;
  outbound: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={
        outbound
          ? "underline decoration-1 underline-offset-2 hover:no-underline text-[#1c7cd5]"
          : "underline decoration-1 underline-offset-2 hover:no-underline text-[#1c7cd5]"
      }
      onClick={(e) => e.stopPropagation()}
    >
      {label}
    </a>
  );
}
