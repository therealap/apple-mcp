import { describe, it, expect } from "bun:test";
import {
  stampNotes,
  stripLine,
  hasLine,
  torontoStamp,
} from "../../utils/provenance.js";

// 2026-10-04 19:40 UTC = 15:40 in Toronto (EDT)
const NOW = new Date("2026-10-04T19:40:00Z");

describe("🤖 Source line (calendar create)", () => {
  it("formats Toronto wall-clock time", () => {
    expect(torontoStamp(NOW)).toBe("2026-10-04 15:40");
    expect(torontoStamp(new Date("2026-12-01T13:05:00Z"))).toBe("2026-12-01 08:05");
  });

  it("stamps a default line when there are no notes", () => {
    expect(stampNotes(undefined, {}, NOW)).toBe(
      "🤖 Source: Claude session · apple-mcp calendar create · created 2026-10-04 15:40",
    );
  });

  it("puts the line below the caller's notes after a blank line", () => {
    const out = stampNotes("Hike with Charlie.", { job: "Weekly Look" }, NOW);
    expect(out).toBe(
      "Hike with Charlie.\n\n🤖 Source: Weekly Look · apple-mcp calendar create · created 2026-10-04 15:40",
    );
  });

  it("adds a from-ref, prefixing 'from' when missing", () => {
    const out = stampNotes("x", { ref: 'email "Bandits Broadcast"' }, NOW);
    expect(out.endsWith(' · from email "Bandits Broadcast"')).toBe(true);
  });

  it("blank job/script fall back to defaults", () => {
    const out = stampNotes("x", { job: "  ", script: "" }, NOW);
    expect(out).toContain("🤖 Source: Claude session · apple-mcp calendar create");
  });

  it("never writes two lines", () => {
    const once = stampNotes("x", {}, NOW);
    const twice = stampNotes(once, { job: "Other" }, NOW);
    expect(twice.match(/🤖 Source:/g)?.length).toBe(1);
    expect(twice).toContain("🤖 Source: Other");
    expect(stripLine(twice)).toBe("x");
    expect(hasLine(twice)).toBe(true);
    expect(hasLine("plain notes")).toBe(false);
  });
});
