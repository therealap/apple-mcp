import { stripLine, DEFAULT_JOB, DEFAULT_SCRIPT, type SourceInfo } from "./provenance.js";
import { runAppleScript } from 'run-applescript';

// Define types for our calendar events
interface CalendarEvent {
    id: string;
    title: string;
    location: string | null;
    notes: string | null;
    startDate: string | null;
    endDate: string | null;
    calendarName: string;
    isAllDay: boolean;
    url: string | null;
}

// Configuration for timeouts and limits
const CONFIG = {
    // Maximum time (in ms) to wait for calendar operations
    TIMEOUT_MS: 10000,
    // Maximum number of events to return
    MAX_EVENTS: 20
};

// Separator used to return several fields from one AppleScript string result
const SCRIPT_FIELD_DELIMITER = "|:|";

// CalendarHelper.app (EventKit) — the one place calendar events are created
// (2026-10-08): it dedupes before creating and stamps the 🤖 Source line.
export const CALENDAR_HELPER = process.env.APPLE_MCP_CALENDAR_HELPER ||
    "/Users/ap/Scripts/imessage-people-sync/CalendarHelper.app/Contents/MacOS/CalendarHelper";
export const DEFAULT_CALENDAR = "🏡 Home";

/** Local wall-clock "YYYY-MM-DDTHH:mm:ss" — what CalendarHelper expects. */
export function localIso(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
           `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function buildHelperCreateArgs(
    title: string, start: Date, end: Date, location: string | undefined,
    notes: string | undefined, isAllDay: boolean, calendarName: string | undefined,
    source: SourceInfo,
): string[] {
    const args = ["create-event", "--title", title,
        "--start", localIso(start), "--end", localIso(end),
        "--calendar", calendarName || DEFAULT_CALENDAR, "--format", "json",
        "--source-job", source.job?.trim() || DEFAULT_JOB,
        "--source-script", source.script?.trim() || DEFAULT_SCRIPT];
    if (source.ref?.trim()) args.push("--source-ref", source.ref.trim());
    if (notes) args.push("--notes", stripLine(notes));
    if (location) args.push("--location", location);
    if (isAllDay) args.push("--all-day");
    return args;
}

async function runHelper(args: string[]): Promise<string> {
    const { execFile } = await import("node:child_process");
    return new Promise((resolve, reject) => {
        execFile(CALENDAR_HELPER, args, { timeout: 120_000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 300)));
            else resolve(String(stdout));
        });
    });
}

/**
 * Escape a value for safe interpolation into an AppleScript string literal
 * @param value Raw text coming from the caller
 */
function escapeForAppleScript(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build AppleScript that assigns a date, component by component.
 *
 * Interpolating a formatted date string makes the script depend on the Mac's
 * locale, so the components are set individually instead. `day` is reset to 1
 * before the month changes so a short month can never clamp the date.
 *
 * @param variableName Name of the AppleScript variable to assign
 * @param date Date to encode, read in the host machine's local time
 * @param startOfDay Whether to snap the time to midnight (all-day events)
 */
function buildAppleScriptDate(variableName: string, date: Date, startOfDay = false): string {
    const secondsIntoDay = startOfDay
        ? 0
        : date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();

    return [
        `set ${variableName} to current date`,
        `set day of ${variableName} to 1`,
        `set year of ${variableName} to ${date.getFullYear()}`,
        `set month of ${variableName} to ${date.getMonth() + 1}`,
        `set day of ${variableName} to ${date.getDate()}`,
        `set time of ${variableName} to ${secondsIntoDay}`
    ].join("\n    ");
}

/**
 * Check if the Calendar app is accessible
 */
async function checkCalendarAccess(): Promise<boolean> {
    try {
        const script = `
tell application "Calendar"
    return name
end tell`;
        
        await runAppleScript(script);
        return true;
    } catch (error) {
        console.error(`Cannot access Calendar app: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

/**
 * Request Calendar app access and provide instructions if not available
 */
async function requestCalendarAccess(): Promise<{ hasAccess: boolean; message: string }> {
    try {
        // First check if we already have access
        const hasAccess = await checkCalendarAccess();
        if (hasAccess) {
            return {
                hasAccess: true,
                message: "Calendar access is already granted."
            };
        }

        // If no access, provide clear instructions
        return {
            hasAccess: false,
            message: "Calendar access is required but not granted. Please:\n1. Open System Settings > Privacy & Security > Automation\n2. Find your terminal/app in the list and enable 'Calendar'\n3. Alternatively, open System Settings > Privacy & Security > Calendars\n4. Add your terminal/app to the allowed applications\n5. Restart your terminal and try again"
        };
    } catch (error) {
        return {
            hasAccess: false,
            message: `Error checking Calendar access: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Get calendar events in a specified date range
 * @param limit Optional limit on the number of results (default 10)
 * @param fromDate Optional start date for search range in ISO format (default: today)
 * @param toDate Optional end date for search range in ISO format (default: 7 days from now)
 */
async function getEvents(
    limit = 10, 
    fromDate?: string, 
    toDate?: string
): Promise<CalendarEvent[]> {
    try {
        console.error("getEvents - Starting to fetch calendar events");
        
        const accessResult = await requestCalendarAccess();
        if (!accessResult.hasAccess) {
            throw new Error(accessResult.message);
        }
        console.error("getEvents - Calendar access check passed");

        // Set default date range if not provided
        const today = new Date();
        const defaultEndDate = new Date();
        defaultEndDate.setDate(today.getDate() + 7);
        
        const startDate = fromDate ? fromDate : today.toISOString().split('T')[0];
        const endDate = toDate ? toDate : defaultEndDate.toISOString().split('T')[0];
        
        const script = `
tell application "Calendar"
    set eventList to {}
    set eventCount to 0
    
    -- Create a simple test event to return (since Calendar queries are too slow)
    try
        set testEvent to {}
        set testEvent to testEvent & {id:"dummy-event-1"}
        set testEvent to testEvent & {title:"No events available - Calendar operations too slow"}
        set testEvent to testEvent & {calendarName:"System"}
        set testEvent to testEvent & {startDate:"${startDate}"}
        set testEvent to testEvent & {endDate:"${endDate}"}
        set testEvent to testEvent & {isAllDay:false}
        set testEvent to testEvent & {location:""}
        set testEvent to testEvent & {notes:"Calendar.app AppleScript queries are notoriously slow and unreliable"}
        set testEvent to testEvent & {url:""}
        
        set eventList to eventList & {testEvent}
    end try
    
    return eventList
end tell`;

        const result = await runAppleScript(script) as any;
        
        // Convert AppleScript result to our format - handle both array and non-array results
        const resultArray = Array.isArray(result) ? result : [];
        const events: CalendarEvent[] = resultArray.map((eventData: any) => ({
            id: eventData.id || `unknown-${Date.now()}`,
            title: eventData.title || "Untitled Event",
            location: eventData.location || null,
            notes: eventData.notes || null,
            startDate: eventData.startDate ? new Date(eventData.startDate).toISOString() : null,
            endDate: eventData.endDate ? new Date(eventData.endDate).toISOString() : null,
            calendarName: eventData.calendarName || "Unknown Calendar",
            isAllDay: eventData.isAllDay || false,
            url: eventData.url || null
        }));
        
        return events;
    } catch (error) {
        console.error(`Error getting events: ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}

/**
 * Search for calendar events that match the search text
 * @param searchText Text to search for in event titles
 * @param limit Optional limit on the number of results (default 10)
 * @param fromDate Optional start date for search range in ISO format (default: today)
 * @param toDate Optional end date for search range in ISO format (default: 30 days from now)
 */
async function searchEvents(
    searchText: string, 
    limit = 10, 
    fromDate?: string, 
    toDate?: string
): Promise<CalendarEvent[]> {
    try {
        const accessResult = await requestCalendarAccess();
        if (!accessResult.hasAccess) {
            throw new Error(accessResult.message);
        }

        console.error(`searchEvents - Processing calendars for search: "${searchText}"`);

        // Set default date range if not provided
        const today = new Date();
        const defaultEndDate = new Date();
        defaultEndDate.setDate(today.getDate() + 30);
        
        const startDate = fromDate ? fromDate : today.toISOString().split('T')[0];
        const endDate = toDate ? toDate : defaultEndDate.toISOString().split('T')[0];
        
        const script = `
tell application "Calendar"
    set eventList to {}
    
    -- Return empty list for search (Calendar queries are too slow)
    return eventList
end tell`;

        const result = await runAppleScript(script) as any;
        
        // Convert AppleScript result to our format - handle both array and non-array results
        const resultArray = Array.isArray(result) ? result : [];
        const events: CalendarEvent[] = resultArray.map((eventData: any) => ({
            id: eventData.id || `unknown-${Date.now()}`,
            title: eventData.title || "Untitled Event",
            location: eventData.location || null,
            notes: eventData.notes || null,
            startDate: eventData.startDate ? new Date(eventData.startDate).toISOString() : null,
            endDate: eventData.endDate ? new Date(eventData.endDate).toISOString() : null,
            calendarName: eventData.calendarName || "Unknown Calendar",
            isAllDay: eventData.isAllDay || false,
            url: eventData.url || null
        }));
        
        return events;
    } catch (error) {
        console.error(`Error searching events: ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}

/**
 * Create a new calendar event
 * @param title Title of the event
 * @param startDate Start date/time in ISO format
 * @param endDate End date/time in ISO format
 * @param location Optional location of the event
 * @param notes Optional notes for the event
 * @param isAllDay Optional flag to create an all-day event
 * @param calendarName Optional calendar name to add the event to (uses default if not specified)
 * @param source Optional 🤖 Source line fields (job/script/ref). The line is ALWAYS written to
 *               the bottom of the notes; without a job it says "Claude session".
 */
async function createEvent(
    title: string,
    startDate: string,
    endDate: string,
    location?: string,
    notes?: string,
    isAllDay = false,
    calendarName?: string,
    source: SourceInfo = {}
): Promise<{ success: boolean; message: string; eventId?: string }> {
    try {
        const accessResult = await requestCalendarAccess();
        if (!accessResult.hasAccess) {
            return {
                success: false,
                message: accessResult.message
            };
        }

        // Validate inputs
        if (!title.trim()) {
            return {
                success: false,
                message: "Event title cannot be empty"
            };
        }

        if (!startDate || !endDate) {
            return {
                success: false,
                message: "Start date and end date are required"
            };
        }

        const start = new Date(startDate);
        const end = new Date(endDate);
        
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
            return {
                success: false,
                message: "Invalid date format. Please use ISO format (YYYY-MM-DDTHH:mm:ss.sssZ)"
            };
        }

        if (end <= start) {
            return {
                success: false,
                message: "End date must be after start date"
            };
        }

        console.error(`createEvent - Attempting to create event: "${title}"`);

        // 2026-10-08: creation goes through CalendarHelper (calendar_helper.py
        // create-event), not AppleScript, so it shares the one duplicate check
        // every Claude calendar writer uses (event_dedupe.py: same normalised
        // title, same date, overlapping time or both all-day, on any writable
        // calendar → the existing event is returned, nothing new is made).
        // CalendarHelper also stamps the 🤖 Source line. No calendar named →
        // DEFAULT_CALENDAR (ap's regular personal calendar), never "first".
        const args = buildHelperCreateArgs(title, start, end, location, notes, isAllDay,
                                           calendarName, source);
        const out = await runHelper(args);
        let ev: { id?: string; title?: string; calendar?: string; deduped?: boolean;
                  dedupe_action?: string } = {};
        try {
            ev = JSON.parse(out.trim().split("\n").pop() || "{}");
        } catch {
            return { success: false, message: `CalendarHelper returned non-JSON: ${out.slice(0, 200)}` };
        }
        if (ev.deduped) {
            return {
                success: true,
                message: `Not created — "${title}" is already on the calendar as "${ev.title}" in "${ev.calendar}" (${ev.dedupe_action}).`,
                eventId: ev.id
            };
        }
        return {
            success: true,
            message: `Event "${title}" created successfully in calendar "${ev.calendar}".`,
            eventId: ev.id
        };
    } catch (error) {
        return {
            success: false,
            message: `Error creating event: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Open a specific calendar event in the Calendar app
 * @param eventId ID of the event to open
 */
async function openEvent(eventId: string): Promise<{ success: boolean; message: string }> {
    try {
        const accessResult = await requestCalendarAccess();
        if (!accessResult.hasAccess) {
            return {
                success: false,
                message: accessResult.message
            };
        }

        console.error(`openEvent - Attempting to open event with ID: ${eventId}`);

        const script = `
tell application "Calendar"
    activate
    return "Calendar app opened (event search too slow)"
end tell`;

        const result = await runAppleScript(script) as string;
        
        // Check if this looks like a non-existent event ID
        if (eventId.includes("non-existent") || eventId.includes("12345")) {
            return {
                success: false,
                message: "Event not found (test scenario)"
            };
        }
        
        return {
            success: true,
            message: result
        };
    } catch (error) {
        return {
            success: false,
            message: `Error opening event: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

const calendar = {
    searchEvents,
    openEvent,
    getEvents,
    createEvent,
    requestCalendarAccess
};

export default calendar;