// Levelled structured logging. Every line is one JSON object on stdout, which is
// what Netlify's Edge Function log view ingests.
//
// Never logged: the bot token, the webhook secret, message text, bio text,
// usernames, image bytes. A matched *domain* is logged; the bio around it is not.

export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = ORDER.info;

/** Called once by config parsing; before that, `info` is assumed. */
export function setLogLevel(level: Level): void {
  threshold = ORDER[level];
}

export function log(level: Level, fields: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const line: Record<string, unknown> = { level, ts: new Date().toISOString(), ...fields };
  for (const key of Object.keys(line)) {
    if (line[key] === undefined) delete line[key];
  }
  console.log(JSON.stringify(line));
}

export const debug = (f: Record<string, unknown>) => log("debug", f);
export const info = (f: Record<string, unknown>) => log("info", f);
export const warn = (f: Record<string, unknown>) => log("warn", f);
export const error = (f: Record<string, unknown>) => log("error", f);

/** Turns an unknown thrown value into something safe to put in a log line. */
export function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** Wall-clock helper for the `ms` block of a verdict line. */
export async function timed<T>(
  into: Record<string, number>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    into[key] = Date.now() - started;
  }
}
