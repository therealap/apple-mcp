/**
 * The 🤖 Source line — which automation made a calendar event (2026-10-04).
 *
 * TypeScript twin of ~/Scripts/imessage-people-sync/provenance.py (creation
 * side only). Every event this server creates gets ONE line at the bottom of
 * its notes, below the caller's notes after a blank line:
 *
 *   🤖 Source: <job> · <script> · created YYYY-MM-DD HH:MM[ · from …]
 *
 * Times are America/Toronto wall-clock, same as CalendarHelper's lines.
 */

export const PREFIX = "🤖 Source:";
export const SEP = " · ";
export const DEFAULT_JOB = "Claude session";
export const DEFAULT_SCRIPT = "apple-mcp calendar create";

const LINE_RE = /^[ \t]*🤖 Source:.*$/gm;

function clean(text: string, limit: number): string {
  const t = text.split(/\s+/).filter(Boolean).join(" ").replaceAll(SEP.trim(), "-");
  return t.length > limit ? `${t.slice(0, limit - 1)}…` : t;
}

/** `from email "<subject>"` style; adds the leading "from " if missing. */
function cleanRef(ref: string): string {
  let r = ref.split(/\s+/).filter(Boolean).join(" ");
  if (!r.toLowerCase().startsWith("from ")) r = `from ${r}`;
  const m = r.match(/^(from [^"]*?)"(.*)"$/);
  if (m) return `${m[1]}"${clean(m[2].replaceAll('"', "'"), 100)}"`;
  return clean(r, 160);
}

/** YYYY-MM-DD HH:MM in America/Toronto. */
export function torontoStamp(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export function hasLine(notes?: string | null): boolean {
  return !!notes && new RegExp(LINE_RE.source, "m").test(notes);
}

export function stripLine(notes?: string | null): string {
  return (notes ?? "").replace(LINE_RE, "").replace(/\s+$/, "").replace(/^\s*\n/, "");
}

export interface SourceInfo {
  job?: string;
  script?: string;
  ref?: string;
}

/** Caller's notes + exactly one 🤖 Source line (a passed-through one is replaced). */
export function stampNotes(
  notes: string | undefined | null,
  source: SourceInfo = {},
  now: Date = new Date(),
): string {
  const job = clean(source.job?.trim() || DEFAULT_JOB, 80);
  const script = clean(source.script?.trim() || DEFAULT_SCRIPT, 80);
  const parts = [`${PREFIX} ${job}`, script, `created ${torontoStamp(now)}`];
  if (source.ref?.trim()) parts.push(cleanRef(source.ref));
  const line = parts.join(SEP);
  const body = stripLine(notes);
  return body ? `${body}\n\n${line}` : line;
}
