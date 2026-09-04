// Bio text -> the set of domains it points at.
//
// Spam bios obfuscate links, so raw substring matching is not enough. Everything
// here is text-only and local: the bot never fetches a linked page. Following a
// hostile URL from inside your own infrastructure is exactly what the sender
// wants, and it would leak the edge node's address.

const ZERO_WIDTH = /[​-‍⁠﻿­]/g;

/** Dot substitutes seen in the wild, plus the bracketed/spelled-out forms. */
const DOT_SUBSTITUTES: Array<[RegExp, string]> = [
  [/\s*[\[({]\s*(?:dot|punto|\.)\s*[\])}]\s*/gi, "."],
  [/\s+(?:dot|d0t)\s+/gi, "."],
  [/[․。．｡˙]/g, "."],
  [/\s*[\[({]\s*(?:at|@)\s*[\])}]\s*/gi, "@"],
];

/**
 * Fold lookalikes and de-obfuscate separators. NFKC first, so fullwidth and
 * mathematical-alphanumeric variants collapse onto ASCII before anything else
 * tries to pattern-match them.
 */
export function normalizeText(raw: string): string {
  let text = raw.normalize("NFKC").replace(ZERO_WIDTH, "");
  for (const [pattern, replacement] of DOT_SUBSTITUTES) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

// Schemed URLs, bare hosts, and @handles. Kept deliberately greedy on the host
// and uninterested in the path: only the domain is ever used.
const URL_PATTERN = /(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,24}(?:\/[^\s<>"']*)?/gi;
const HANDLE_PATTERN = /@([A-Za-z][\w]{3,31})/g;

export interface ExtractedLink {
  /** Lowercased hostname, punycode-encoded if it was an IDN. */
  host: string;
  /** True when the link was written as a bare @handle rather than a URL. */
  handle: boolean;
  /** True for a t.me invite link (`t.me/+…`, `t.me/joinchat/…`). */
  invite: boolean;
}

function toHost(candidate: string): string | null {
  const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `http://${candidate}`;
  try {
    const url = new URL(withScheme);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!host.includes(".") || host.endsWith(".")) return null;
    return host;
  } catch {
    return null;
  }
}

function isInvite(candidate: string, host: string): boolean {
  if (!/(^|\.)t\.me$|(^|\.)telegram\.(me|dog)$/.test(host)) return false;
  return /\/(?:joinchat\/|\+)/.test(candidate);
}

/** All links a bio points at, deduplicated by host+shape. */
export function extractLinks(rawText: string): ExtractedLink[] {
  const text = normalizeText(rawText);
  const out = new Map<string, ExtractedLink>();

  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = match[0];
    const host = toHost(candidate);
    if (!host) continue;
    const link: ExtractedLink = { host, handle: false, invite: isInvite(candidate, host) };
    const key = `${host}:${link.invite}`;
    if (!out.has(key)) out.set(key, link);
  }

  // A bare @handle is a Telegram link with the t.me/ elided.
  for (const match of text.matchAll(HANDLE_PATTERN)) {
    const key = `t.me:@${match[1].toLowerCase()}`;
    if (!out.has(key)) out.set(key, { host: "t.me", handle: true, invite: false });
  }

  return [...out.values()];
}

/**
 * A host and every parent domain of it, longest first:
 * `a.b.example.co.uk` -> `a.b.example.co.uk`, `b.example.co.uk`, … , `co.uk`.
 *
 * Matching against the whole chain is what makes one blocklist entry cover all
 * of a domain's subdomains, without needing a public-suffix list on the edge.
 */
export function domainChain(host: string): string[] {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + 1 < labels.length; i++) {
    out.push(labels.slice(i).join("."));
  }
  return out;
}
