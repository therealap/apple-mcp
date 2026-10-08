// 2026-10-08: calendar create goes through CalendarHelper (dedupe + 🤖 Source line).
import { describe, expect, test } from "bun:test";
import { buildHelperCreateArgs, DEFAULT_CALENDAR, localIso } from "../../utils/calendar";

describe("calendar create → CalendarHelper", () => {
  const start = new Date(2026, 9, 8, 19, 0, 0);
  const end = new Date(2026, 9, 8, 21, 30, 0);

  test("local wall-clock ISO, no timezone suffix", () => {
    expect(localIso(start)).toBe("2026-10-08T19:00:00");
  });

  test("create-event args carry source, json format and default calendar", () => {
    const a = buildHelperCreateArgs("🎉 Ava — Dance", start, end, "Speers Rd", "bring $20",
                                    false, undefined, { job: "Weekly Look", ref: "from texts" });
    expect(a.slice(0, 3)).toEqual(["create-event", "--title", "🎉 Ava — Dance"]);
    expect(a[a.indexOf("--calendar") + 1]).toBe(DEFAULT_CALENDAR);
    expect(a[a.indexOf("--source-job") + 1]).toBe("Weekly Look");
    expect(a[a.indexOf("--source-ref") + 1]).toBe("from texts");
    expect(a).toContain("--format");
    expect(a).not.toContain("--all-day");
    expect(a).not.toContain("--allow-duplicate");
  });

  test("a caller's own 🤖 Source line is stripped (CalendarHelper adds the one line)", () => {
    const a = buildHelperCreateArgs("x", start, end, undefined,
                                    "note\n\n🤖 Source: old · x · created 2026-01-01 00:00",
                                    true, "🧑‍🧑‍🧒‍🧒 Family", {});
    expect(a[a.indexOf("--notes") + 1]).toBe("note");
    expect(a).toContain("--all-day");
  });
});
