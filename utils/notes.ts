import { runAppleScript } from "run-applescript";

// Configuration
const CONFIG = {
	MAX_NOTES: 50,
	MAX_CONTENT_PREVIEW: 200,
	TIMEOUT_MS: 8000,
};

// Folders excluded from unscoped search/list results.
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

async function checkNotesAccess(): Promise<boolean> {
	try {
		const script = `\ntell application "Notes"\n    return name\nend tell`;
		await runAppleScript(script);
		return true;
	} catch (error) {
		console.error(
			`Cannot access Notes app: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

async function requestNotesAccess(): Promise<{ hasAccess: boolean; message: string }> {
	try {
		const hasAccess = await checkNotesAccess();
		if (hasAccess) {
			return { hasAccess: true, message: "Notes access is already granted." };
		}
		return {
			hasAccess: false,
			message: "Notes access is required but not granted. Please:\n1. Open System Settings > Privacy & Security > Automation\n2. Find your terminal/app in the list and enable 'Notes'\n3. Restart your terminal and try again\n4. If the option is not available, run this command again to trigger the permission dialog",
		};
	} catch (error) {
		return {
			hasAccess: false,
			message: `Error checking Notes access: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function buildExcludedFoldersLiteral(): string {
	return "{" + EXCLUDED_FOLDERS.map((f) => `"${f}"`).join(", ") + "}";
}

/**
 * Iterate `notes of app` directly (proven pattern from original code), then
 * filter by container folder name — excludes trash by default, or scopes to
 * a specific folder when folderName is provided.
 */
async function getAllNotes(folderName?: string): Promise<Note[]> {
	try {
		const accessResult = await requestNotesAccess();
		if (!accessResult.hasAccess) {
			throw new Error(accessResult.message);
		}

		const scopedFolderLiteral = folderName ? `"${folderName}"` : `""`;
		const excludedLiteral = buildExcludedFoldersLiteral();

		const script = `
tell application "Notes"
    set notesList to {}
    set noteCount to 0
    set targetFolderName to ${scopedFolderLiteral}
    set excludedFolders to ${excludedLiteral}

    set allNotes to notes

    repeat with i from 1 to (count of allNotes)
        if noteCount >= ${CONFIG.MAX_NOTES} then exit repeat

        try
            set currentNote to item i of allNotes
            set noteContainerName to ""
            try
                set noteContainerName to name of container of currentNote
            on error
                set noteContainerName to ""
            end try

            set shouldInclude to true

            if targetFolderName is not "" and noteContainerName is not targetFolderName then
                set shouldInclude to false
            end if

            if targetFolderName is "" and excludedFolders contains noteContainerName then
                set shouldInclude to false
            end if

            if shouldInclude then
                set noteName to name of currentNote
                set noteContent to plaintext of currentNote

                if (length of noteContent) > ${CONFIG.MAX_CONTENT_PREVIEW} then
                    set noteContent to (characters 1 thru ${CONFIG.MAX_CONTENT_PREVIEW} of noteContent) as string
                    set noteContent to noteContent & "..."
                end if

                set noteInfo to {name:noteName, content:noteContent}
                set notesList to notesList & {noteInfo}
                set noteCount to noteCount + 1
            end if
        on error
        end try
    end repeat

    return notesList
end tell`;

		const result = (await runAppleScript(script)) as any;
		const resultArray = normalizeApplescriptListResult(result);

		return resultArray.map((noteData: any) => ({
			name: (noteData && noteData.name) ? noteData.name : "Untitled Note",
			content: (noteData && noteData.content) ? noteData.content : "",
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
		const excludedLiteral = buildExcludedFoldersLiteral();

		const script = `
tell application "Notes"
    set matchedNotes to {}
    set noteCount to 0
    set searchTerm to "${searchTerm}"
    set targetFolderName to ${scopedFolderLiteral}
    set excludedFolders to ${excludedLiteral}

    set allNotes to notes

    repeat with i from 1 to (count of allNotes)
        if noteCount >= ${CONFIG.MAX_NOTES} then exit repeat

        try
            set currentNote to item i of allNotes
            set noteContainerName to ""
            try
                set noteContainerName to name of container of currentNote
            on error
                set noteContainerName to ""
            end try

            set shouldInclude to true

            if targetFolderName is not "" and noteContainerName is not targetFolderName then
                set shouldInclude to false
            end if

            if targetFolderName is "" and excludedFolders contains noteContainerName then
                set shouldInclude to false
            end if

            if shouldInclude then
                set noteName to name of currentNote
                set noteContent to plaintext of currentNote

                if (noteName contains searchTerm) or (noteContent contains searchTerm) then
                    if (length of noteContent) > ${CONFIG.MAX_CONTENT_PREVIEW} then
                        set noteContent to (characters 1 thru ${CONFIG.MAX_CONTENT_PREVIEW} of noteContent) as string
                        set noteContent to noteContent & "..."
                    end if

                    set noteInfo to {name:noteName, content:noteContent}
                    set matchedNotes to matchedNotes & {noteInfo}
                    set noteCount to noteCount + 1
                end if
            end if
        on error
        end try
    end repeat

    return matchedNotes
end tell`;

		const result = (await runAppleScript(script)) as any;
		const resultArray = normalizeApplescriptListResult(result);

		return resultArray.map((noteData: any) => ({
			name: (noteData && noteData.name) ? noteData.name : "Untitled Note",
			content: (noteData && noteData.content) ? noteData.content : "",
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
 * AppleScript's `{}` is ambiguous — empty list vs empty record. run-applescript
 * may return `{}` (empty JS object) for an empty list, which was previously
 * masqueraded as one phantom "Untitled Note" result. Treat objects with no
 * name/content keys as empty results.
 */
function normalizeApplescriptListResult(result: any): any[] {
	if (Array.isArray(result)) return result;
	if (result === null || result === undefined || result === "") return [];
	if (typeof result === "object") {
		if (result.name !== undefined || result.content !== undefined) {
			return [result];
		}
		return [];
	}
	return [result];
}

async function createNote(
	title: string,
	body: string,
	folderName: string = "Claude",
): Promise<CreateNoteResult> {
	try {
		const accessResult = await requestNotesAccess();
		if (!accessResult.hasAccess) {
			return { success: false, message: accessResult.message };
		}

		if (!title || title.trim() === "") {
			return { success: false, message: "Note title cannot be empty" };
		}

		const formattedBody = body.trim();
		const tmpFile = `/tmp/note-content-${Date.now()}.txt`;
		const fs = require("fs");
		fs.writeFileSync(tmpFile, formattedBody, "utf8");

		const script = `
tell application "Notes"
    set targetFolder to null
    set folderFound to false
    set actualFolderName to "${folderName}"

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
    end try

    if not folderFound and ("${folderName}" is "Claude" or "${folderName}" is "Test-Claude") then
        try
            make new folder with properties {name:"${folderName}"}
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
            set actualFolderName to "Notes"
        end try
    end if

    set noteContent to read file POSIX file "${tmpFile}" as «class utf8»

    if folderFound and targetFolder is not null then
        make new note at targetFolder with properties {name:"${title.replace(/"/g, '\\"')}", body:noteContent}
        return "SUCCESS:" & actualFolderName & ":false"
    else
        make new note with properties {name:"${title.replace(/"/g, '\\"')}", body:noteContent}
        return "SUCCESS:Notes:true"
    end if
end tell`;

		const result = (await runAppleScript(script)) as string;

		try {
			fs.unlinkSync(tmpFile);
		} catch (e) {}

		if (result && typeof result === "string" && result.startsWith("SUCCESS:")) {
			const parts = result.split(":");
			const folderName = parts[1] || "Notes";
			const usedDefaultFolder = parts[2] === "true";

			return {
				success: true,
				note: { name: title, content: formattedBody },
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

async function getNotesFromFolder(
	folderName: string,
): Promise<{ success: boolean; notes?: Note[]; message?: string }> {
	try {
		const notes = await getAllNotes(folderName);
		return { success: true, notes };
	} catch (error) {
		return {
			success: false,
			message: `Failed to get notes from folder: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

async function getRecentNotesFromFolder(
	folderName: string,
	limit: number = 5,
): Promise<{ success: boolean; notes?: Note[]; message?: string }> {
	try {
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

async function getNotesByDateRange(
	folderName: string,
	fromDate?: string,
	toDate?: string,
	limit: number = 20,
): Promise<{ success: boolean; notes?: Note[]; message?: string }> {
	try {
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
