import { runAppleScript } from "run-applescript";

// Configuration
const CONFIG = {
	// Maximum notes to process (to avoid performance issues)
	MAX_NOTES: 50,
	// Maximum content length for previews
	MAX_CONTENT_PREVIEW: 200,
	// Timeout for operations
	TIMEOUT_MS: 8000,
};

// Folders that are always excluded from search/list unless the caller
// explicitly targets them via folderName. Add to this list if you have
// other "archive" folders you never want surfacing in general queries.
const EXCLUDED_FOLDERS = ["Recently Deleted"];

type Note = {
	name: string;
	content: string;
	creationDate?: Date;
	modificationDate?: Date;
};

type CreateNoteResult = {
	success: boolean;
	note?: Note;
	message?: string;
	folderName?: string;
	usedDefaultFolder?: boolean;
};

/**
 * Check if Notes app is accessible
 */
async function checkNotesAccess(): Promise<boolean> {
	try {
		const script = `
tell application "Notes"
    return name
end tell`;

		await runAppleScript(script);
		return true;
	} catch (error) {
		console.error(
			`Cannot access Notes app: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

/**
 * Request Notes app access and provide instructions if not available
 */
async function requestNotesAccess(): Promise<{ hasAccess: boolean; message: string }> {
	try {
		// First check if we already have access
		const hasAccess = await checkNotesAccess();
		if (hasAccess) {
			return {
				hasAccess: true,
				message: "Notes access is already granted."
			};
		}

		// If no access, provide clear instructions
		return {
			hasAccess: false,
			message: "Notes access is required but not granted. Please:\n1. Open System Settings > Privacy & Security > Automation\n2. Find your terminal/app in the list and enable 'Notes'\n3. Restart your terminal and try again\n4. If the option is not available, run this command again to trigger the permission dialog"
		};
	} catch (error) {
		return {
			hasAccess: false,
			message: `Error checking Notes access: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}

/**
 * Build an AppleScript literal list of excluded folder names, e.g.
 *   {"Recently Deleted"}
 */
function buildExcludedFoldersList(): string {
	return "{" + EXCLUDED_FOLDERS.map((f) => `"${f}"`).join(", ") + "}";
}

/**
 * Get notes from Notes app. Iterates through folders so we can skip the
 * Recently Deleted (trash) folder and scope to a specific folder when
 * folderName is provided. Limited for performance.
 */
async function getAllNotes(folderName?: string): Promise<Note[]> {
	try {
		const accessResult = await requestNotesAccess();
		if (!accessResult.hasAccess) {
			throw new Error(accessResult.message);
		}

		const scopedFolderLiteral = folderName ? `"${folderName}"` : `""`;
		const excludedList = buildExcludedFoldersList();

		const script = `
tell application "Notes"
    set notesList to {}
    set noteCount to 0
    set targetFolderName to ${scopedFolderLiteral}
    set excludedFolders to ${excludedList}

    -- Iterate folders so we can skip the trash / recently-deleted folder
    set allFolders to folders

    repeat with currentFolder in allFolders
        if noteCount >= ${CONFIG.MAX_NOTES} then exit repeat

        set thisFolderName to name of currentFolder
        set shouldInclude to true

        -- If a specific folder was requested, only include that one
        if targetFolderName is not "" and thisFolderName is not targetFolderName then
            set shouldInclude to false
        end if

        -- Always skip excluded folders unless the caller explicitly asked for one
        if targetFolderName is "" and excludedFolders contains thisFolderName then
            set shouldInclude to false
        end if

        if shouldInclude then
            try
                set folderNotes to notes of currentFolder
                repeat with i from 1 to (count of folderNotes)
                    if noteCount >= ${CONFIG.MAX_NOTES} then exit repeat

                    try
                        set currentNote to item i of folderNotes
                        set noteName to name of currentNote
                        set noteContent to plaintext of currentNote

                        -- Limit content for preview
                        if (length of noteContent) > ${CONFIG.MAX_CONTENT_PREVIEW} then
                            set noteContent to (characters 1 thru ${CONFIG.MAX_CONTENT_PREVIEW} of noteContent) as string
                            set noteContent to noteContent & "..."
                        end if

                        set noteInfo to {name:noteName, content:noteContent}
                        set notesList to notesList & {noteInfo}
                        set noteCount to noteCount + 1
                    on error
                        -- Skip problematic notes
                    end try
                end repeat
            on error
                -- Skip folders we can't read
            end try
        end if
    end repeat

    return notesList
end tell`;

		const result = (await runAppleScript(script)) as any;

		// Convert AppleScript result to our format
		const resultArray = Array.isArray(result) ? result : result ? [result] : [];

		return resultArray.map((noteData: any) => ({
			name: noteData.name || "Untitled Note",
			content: noteData.content || "",
			creationDate: undefined,
			modificationDate: undefined,
		}));
	} catch (error) {
		console.error(
			`Error getting all notes: ${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
}

/**
 * Find notes by search text. Iterates folders so we can skip the trash
 * folder and honour an optional folderName scope.
 */
async function findNote(searchText: string, folderName?: string): Promise<Note[]> {
	try {
		const accessResult = await requestNotesAccess();
		if (!accessResult.hasAccess) {
			throw new Error(accessResult.message);
		}

		if (!searchText || searchText.trim() === "") {
			return [];
		}

		const searchTerm = searchText.toLowerCase();
		const scopedFolderLiteral = folderName ? `"${folderName}"` : `""`;
		const excludedList = buildExcludedFoldersList();

		const script = `
tell application "Notes"
    set matchedNotes to {}
    set noteCount to 0
    set searchTerm to "${searchTerm}"
    set targetFolderName to ${scopedFolderLiteral}
    set excludedFolders to ${excludedList}

    -- Iterate folders so we can filter by folder and skip trash
    set allFolders to folders

    repeat with currentFolder in allFolders
        if noteCount >= ${CONFIG.MAX_NOTES} then exit repeat

        set thisFolderName to name of currentFolder
        set shouldInclude to true

        if targetFolderName is not "" and thisFolderName is not targetFolderName then
            set shouldInclude to false
        end if

        if targetFolderName is "" and excludedFolders contains thisFolderName then
            set shouldInclude to false
        end if

        if shouldInclude then
            try
                set folderNotes to notes of currentFolder
                repeat with i from 1 to (count of folderNotes)
                    if noteCount >= ${CONFIG.MAX_NOTES} then exit repeat

                    try
                        set currentNote to item i of folderNotes
                        set noteName to name of currentNote
                        set noteContent to plaintext of currentNote

                        -- Simple case-insensitive search in name and content
                        if (noteName contains searchTerm) or (noteContent contains searchTerm) then
                            -- Limit content for preview
                            if (length of noteContent) > ${CONFIG.MAX_CONTENT_PREVIEW} then
                                set noteContent to (characters 1 thru ${CONFIG.MAX_CONTENT_PREVIEW} of noteContent) as string
                                set noteContent to noteContent & "..."
                            end if

                            set noteInfo to {name:noteName, content:noteContent}
                            set matchedNotes to matchedNotes & {noteInfo}
                            set noteCount to noteCount + 1
                        end if
                    on error
                        -- Skip problematic notes
                    end try
                end repeat
            on error
                -- Skip folders we can't read
            end try
        end if
    end repeat

    return matchedNotes
end tell`;

		const result = (await runAppleScript(script)) as any;

		// Convert AppleScript result to our format
		const resultArray = Array.isArray(result) ? result : result ? [result] : [];

		return resultArray.map((noteData: any) => ({
			name: noteData.name || "Untitled Note",
			content: noteData.content || "",
			creationDate: undefined,
			modificationDate: undefined,
		}));
	} catch (error) {
		console.error(
			`Error finding notes: ${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
}

/**
 * Create a new note
 */
async function createNote(
	title: string,
	body: string,
	folderName: string = "Claude",
): Promise<CreateNoteResult> {
	try {
		const accessResult = await requestNotesAccess();
		if (!accessResult.hasAccess) {
			return {
				success: false,
				message: accessResult.message,
			};
		}

		// Validate inputs
		if (!title || title.trim() === "") {
			return {
				success: false,
				message: "Note title cannot be empty",
			};
		}

		// Keep the body as-is to preserve original formatting
		// Notes.app handles markdown and formatting natively
		const formattedBody = body.trim();

		// Use file-based approach for complex content to avoid AppleScript string issues
		const tmpFile = `/tmp/note-content-${Date.now()}.txt`;
		const fs = require("fs");

		// Write content to temporary file to avoid AppleScript escaping issues
		fs.writeFileSync(tmpFile, formattedBody, "utf8");

		const script = `
tell application "Notes"
    set targetFolder to null
    set folderFound to false
    set actualFolderName to "${folderName}"

    -- Try to find the specified folder
    try
        set allFolders to folders
        repeat with currentFolder in allFolders
            if name of currentFolder is "${folderName}" then
                set targetFolder to currentFolder
                set folderFound to true
                exit repeat
            end if
        end repeat
    on error
        -- Folders might not be accessible
    end try

    -- If folder not found and it's a test folder, try to create it
    if not folderFound and ("${folderName}" is "Claude" or "${folderName}" is "Test-Claude") then
        try
            make new folder with properties {name:"${folderName}"}
            -- Try to find it again
            set allFolders to folders
            repeat with currentFolder in allFolders
                if name of currentFolder is "${folderName}" then
                    set targetFolder to currentFolder
                    set folderFound to true
                    set actualFolderName to "${folderName}"
                    exit repeat
                end if
            end repeat
        on error
            -- Folder creation failed, use default
            set actualFolderName to "Notes"
        end try
    end if

    -- Read content from file to preserve formatting
    set noteContent to read file POSIX file "${tmpFile}" as «class utf8»

    -- Create the note with proper content
    if folderFound and targetFolder is not null then
        -- Create note in specified folder
        make new note at targetFolder with properties {name:"${title.replace(/"/g, '\\"')}", body:noteContent}
        return "SUCCESS:" & actualFolderName & ":false"
    else
        -- Create note in default location
        make new note with properties {name:"${title.replace(/"/g, '\\"')}", body:noteContent}
        return "SUCCESS:Notes:true"
    end if
end tell`;

		const result = (await runAppleScript(script)) as string;

		// Clean up temporary file
		try {
			fs.unlinkSync(tmpFile);
		} catch (e) {
			// Ignore cleanup errors
		}

		// Parse the result string format: "SUCCESS:folderName:usedDefault"
		if (result && typeof result === "string" && result.startsWith("SUCCESS:")) {
			const parts = result.split(":");
			const folderName = parts[1] || "Notes";
			const usedDefaultFolder = parts[2] === "true";

			return {
				success: true,
				note: {
					name: title,
					content: formattedBody,
				},
				folderName: folderName,
				usedDefaultFolder: usedDefaultFolder,
			};
		} else {
			return {
				success: false,
				message: `Failed to create note: ${result || "No result from AppleScript"}`,
			};
		}
	} catch (error) {
		return {
			success: false,
			message: `Failed to create note: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Get notes from a specific folder. Actually returns the notes now
 * (previously stubbed to an empty array). Also excluded from Recently
 * Deleted unless the folderName itself IS "Recently Deleted".
 */
async function getNotesFromFolder(
	folderName: string,
): Promise<{ success: boolean; notes?: Note[]; message?: string }> {
	try {
		const accessResult = await requestNotesAccess();
		if (!accessResult.hasAccess) {
			return {
				success: false,
				message: accessResult.message,
			};
		}

		const script = `
tell application "Notes"
    set notesList to {}
    set noteCount to 0
    set folderFound to false

    try
        set allFolders to folders
        repeat with currentFolder in allFolders
            if name of currentFolder is "${folderName}" then
                set folderFound to true

                set folderNotes to notes of currentFolder

                repeat with i from 1 to (count of folderNotes)
                    if noteCount >= ${CONFIG.MAX_NOTES} then exit repeat

                    try
                        set currentNote to item i of folderNotes
                        set noteName to name of currentNote
                        set noteContent to plaintext of currentNote

                        -- Limit content for preview
                        if (length of noteContent) > ${CONFIG.MAX_CONTENT_PREVIEW} then
                            set noteContent to (characters 1 thru ${CONFIG.MAX_CONTENT_PREVIEW} of noteContent) as string
                            set noteContent to noteContent & "..."
                        end if

                        set noteInfo to {name:noteName, content:noteContent}
                        set notesList to notesList & {noteInfo}
                        set noteCount to noteCount + 1
                    on error
                        -- Skip problematic notes
                    end try
                end repeat

                exit repeat
            end if
        end repeat
    on error
        -- Handle folder access errors
    end try

    if not folderFound then
        error "FOLDER_NOT_FOUND"
    end if

    return notesList
end tell`;

		const result = (await runAppleScript(script)) as any;

		const resultArray = Array.isArray(result) ? result : result ? [result] : [];

		const notes: Note[] = resultArray.map((noteData: any) => ({
			name: noteData.name || "Untitled Note",
			content: noteData.content || "",
			creationDate: undefined,
			modificationDate: undefined,
		}));

		return {
			success: true,
			notes,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("FOLDER_NOT_FOUND")) {
			return {
				success: false,
				message: `Folder not found: ${folderName}`,
			};
		}
		return {
			success: false,
			message: `Failed to get notes from folder: ${message}`,
		};
	}
}

/**
 * Get recent notes from a specific folder
 */
async function getRecentNotesFromFolder(
	folderName: string,
	limit: number = 5,
): Promise<{ success: boolean; notes?: Note[]; message?: string }> {
	try {
		// getNotesFromFolder now returns real notes; slice for recent-N.
		const result = await getNotesFromFolder(folderName);

		if (result.success && result.notes) {
			return {
				success: true,
				notes: result.notes.slice(0, Math.min(limit, result.notes.length)),
			};
		}

		return result;
	} catch (error) {
		return {
			success: false,
			message: `Failed to get recent notes from folder: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Get notes by date range (simplified implementation)
 */
async function getNotesByDateRange(
	folderName: string,
	fromDate?: string,
	toDate?: string,
	limit: number = 20,
): Promise<{ success: boolean; notes?: Note[]; message?: string }> {
	try {
		// Delegate to folder read; date filtering left as a future improvement
		// (AppleScript date parsing is expensive and this call site is rare).
		const result = await getNotesFromFolder(folderName);
		if (result.success && result.notes) {
			return {
				success: true,
				notes: result.notes.slice(0, Math.min(limit, result.notes.length)),
			};
		}
		return result;
	} catch (error) {
		return {
			success: false,
			message: `Failed to get notes by date range: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export default {
	getAllNotes,
	findNote,
	createNote,
	getNotesFromFolder,
	getRecentNotesFromFolder,
	getNotesByDateRange,
	requestNotesAccess,
};
