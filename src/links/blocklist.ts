// Domain matching, and the optional Safe Browsing second opinion.

import type { Config } from "../config.ts";
import { errText, warn } from "../log.ts";
import { domainChain, type ExtractedLink, extractLinks } from "./normalize.ts";

export interface LinkFinding {
  matchedDomain: string;
  rule: "blocklist" | "safe_browsing" | "bio_max_links" | "bio_invite";
}

export class Blocklist {
  #domains: Set<string>;
  #loaded: Promise<void> | null = null;
  #url: string | null;

  constructor(domains: string[], url: string | null) {
    this.#domains = new Set(domains.map((d) => d.toLowerCase().replace(/^\.*/, "")));
    this.#url = url;
  }

  get size(): number {
    return this.#domains.size;
  }

  /**
   * Fetches LINK_BLOCKLIST_URL once per isolate. A failure leaves the inline
   * list in place and is logged — it never becomes a reason to flag or to skip
   * checking.
   */
  ensureLoaded(): Promise<void> {
    if (!this.#url) return Promise.resolve();
    return (this.#loaded ??= (async () => {
      try {
        const response = await fetch(this.#url!);
        if (!response.ok) throw new Error(`http ${response.status}`);
        const text = await response.text();
        for (const line of text.split("\n")) {
          const domain = line.split("#")[0].trim().toLowerCase();
          if (domain) this.#domains.add(domain);
        }
      } catch (e) {
        warn({ event: "blocklist_fetch_failed", error: errText(e) });
        this.#loaded = null; // let the next cold request retry
      }
    })());
  }

  /** The blocklisted domain a host resolves to, or null. */
  match(host: string): string | null {
    for (const domain of domainChain(host)) {
      if (this.#domains.has(domain)) return domain;
    }
    return null;
  }
}

/**
 * Judge a bio. Returns every finding, so the log can say which rule fired.
 * Text is never returned or logged — only the matched domain.
 */
export function checkBioLinks(
  bio: string,
  blocklist: Blocklist,
  config: Config,
): { links: ExtractedLink[]; findings: LinkFinding[] } {
  const links = extractLinks(bio);
  const findings: LinkFinding[] = [];

  for (const link of links) {
    const matched = blocklist.match(link.host);
    if (matched) findings.push({ matchedDomain: matched, rule: "blocklist" });
  }

  if (config.bioMaxLinks !== null && links.length > config.bioMaxLinks) {
    findings.push({ matchedDomain: `${links.length} links`, rule: "bio_max_links" });
  }

  if (config.bioBlockInvites) {
    const invite = links.find((link) => link.invite);
    if (invite) findings.push({ matchedDomain: invite.host, rule: "bio_invite" });
  }

  return { links, findings };
}

/**
 * Optional Google Safe Browsing lookup for hosts the local list doesn't know.
 *
 * THIS SENDS DOMAINS EXTRACTED FROM USER BIOS TO GOOGLE, which is a real privacy
 * change from the local-only default — hence off unless a key is configured.
 * A failure returns no finding: an unreachable checker never justifies a ban.
 */
export async function checkSafeBrowsing(
  hosts: string[],
  apiKey: string,
): Promise<LinkFinding | null> {
  if (hosts.length === 0) return null;
  const endpoint = `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${
    encodeURIComponent(apiKey)
  }`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client: { clientId: "nudity-detector-bot", clientVersion: "1.0.0" },
        threatInfo: {
          threatTypes: [
            "MALWARE",
            "SOCIAL_ENGINEERING",
            "UNWANTED_SOFTWARE",
            "POTENTIALLY_HARMFUL_APPLICATION",
          ],
          platformTypes: ["ANY_PLATFORM"],
          threatEntryTypes: ["URL"],
          threatEntries: hosts.map((host) => ({ url: `http://${host}/` })),
        },
      }),
    });
    if (!response.ok) throw new Error(`http ${response.status}`);
    const body = await response.json() as { matches?: Array<{ threat?: { url?: string } }> };
    const url = body.matches?.[0]?.threat?.url;
    if (!url) return null;
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch { /* keep the raw value */ }
    return { matchedDomain: host, rule: "safe_browsing" };
  } catch (e) {
    warn({ event: "safe_browsing_failed", error: errText(e) });
    return null;
  }
}
