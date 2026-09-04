// The first trust gate: proof that the request came from Telegram and not from
// someone POSTing hand-written JSON at a public URL.

/**
 * Length-independent comparison, so the check leaks nothing about the secret by
 * timing. Compared before the request body is read.
 */
export function secretMatches(expected: string, received: string | null): boolean {
  if (!expected || !received) return false;
  const a = new TextEncoder().encode(received);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

export const SECRET_HEADER = "x-telegram-bot-api-secret-token";
