import { runAppleScript } from "run-applescript";

// Configuration
const CONFIG = {
	MAX_NOTES: 50,
	MAX_CONTENT_PREVIEW: 200,
	TIMEOUT_MS: 8000,
};

const EXCLUDED_FOLDERS = ["Recently Deleted"];

// Delimiters used to encode note records as a single string returned from
// AppleScript. The run-applescript bridge does not reliably parse lists of
// records; a delimited string is far more portable.
const FIELD_SEP = "␞"; // ␞ (record separator)
const RECORD_SEP = "␟"; // ␟ (unit separator)

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

function asLiteral(str: string): string {
	return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Parse the delimited string returned by the AppleScript helpers into Note[].
 * Format: name<FS>content<RS>name<FS>content<RS>...
 * An empty return string means zero notes.
 */
function parseDelimitedNotes(result: any): Note[] {
	if (typeof result !== "string" || result.length === 0) return [];
	const raw = result;
	const records = raw.split(RECORD_SEP).filter((r) => r.length > 0);
	return records.map((rec) => {
		const [name, content] = rec.split(FIELD_SEP);
		return {
			name: name || "Untitled Note",
			content: content || "",
			creationDate: undefined,
			modificationDate: undefined,
		};
	});
}

/**
 * Read notes across all folders (or scoped to one), returning them as a
 * delimited string that JS can safely split. Excludes Recently Deleted
 * unless the caller explicitly asks for that folder.
 */
async function getAllNotes(folderName?: string): Promise<Note[]> {
	try {
		const accessResult = await requestNotesAccess();
		if (!accessResult.hasAccess) {
			throw new Error(accessResult.message);
		}

		const script = folderName
			? buildScopedListScript(folderName)
			: buildUnscopedListScript();

		const result = await runAppleScript(script);
		return parseDelimitedNotes(result);
	} catch (error) {
		console.error(
			`Error getting all notes: ${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
}

function buildUnscopedListScript(): string {
	const excludedNamesList = EXCLUDED_FOLDERS.map(asLiteral).join(", ");
	const fieldSepLit = asLiteral(FIELD_SEP);
	const recordSepLit = asLiteral(RECORD_SEP);

	return `
tell application "Notes"
    set fieldSep to ${fieldSepLit}
    set recordSep to ${recordSepLit}
    set outText to ""
    set noteCount to 0
    set excludedFolders to {${excludedNamesList}}

    set allFolders to folders
    repeat with currentFolder in allFolders
        if noteCount ≥ ${CONFIG.MAX_NOTES} then exit repeat

        set thisFolderName to name of currentFolder
        if excludedFolders does not contain thisFolderName then
            try
                set folderNotes to notes of currentFolder
                repeat with i from 1 to (count of folderNotes)
                    if noteCount ≥ ${CONFIG.MAX_NOTES} then exit repeat
                    try
                        set currentNote to item i of folderNotes
                        set noteName to name of currentNote
                        set noteContent to plaintext of currentNote

                        if (length of noteContent) > ${CONFIG.MAX_CONTENT_PREVIEW} then
                            set noteContent to (characters 1 thru ${CONFIG.MAX_CONTENT_PREVIEW} of noteContent) as string
                            set noteContent to noteContent & "..."
                        end if

                        set outText to outText & noteName & fieldSep & noteContent & recordSep
                        set noteCount to noteCount + 1
                    on error
                    end try
                end repeat
            on error
            end try
        end if
    end repeat

    return outText
end tell`;
}

function buildScopedListScript(folderName: string): string {
	const folderLiteral = asLiteral(folderName);
	const fieldSepLit = asLiteral(FIELD_SEP);
	const recordSepLit = asLiteral(RECORD_SEP);

	return `
tell application "Notes"
    set fieldSep to ${fieldSepLit}
    set recordSep to ${recordSepLit}
    set outText to ""
    set noteCount to 0
    set targetName to ${folderLiteral}

    set matchingFolders to {}
    try
        set allFolders to folders
        repeat with currentFolder in allFolders
            try
                if name of currentFolder is targetName then
                    set matchingFolders to matchingFolders & {currentFolder}
                end if
            on error
            end try
        end repeat
    on error
    end try

    if (count of matchingFolders) is 0 then
        return outText
    end if

    repeat with currentFolder in matchingFolders
        if noteCount ≥ ${CONFIG.MAX_NOTES} then exit repeat
        try
            set folderNotes to notes of currentFolder
            repeat with i from 1 to (count of folderNotes)
                if noteCount ≥ ${CONFIG.MAX_NOTES} then exit repeat
                try
                    set currentNote to item i of folderNotes
                    set noteName to name of currentNote
                    set noteContent to plaintext of currentNote

                    if (length of noteContent) > ${CONFIG.MAX_CONTENT_PREVIEW} then
                        set noteContent to (characters 1 thru ${CONFIG.MAX_CONTENT_PREVIEW} of noteContent) as string
                        set noteContent to noteContent & "..."
                    end if

                    set outText to outText & noteName & fieldSep & noteContent & recordSep
                    set noteCount to noteCount + 1
                on error
                end try
            end repeat
        on error
        end try
    end repeat

    return outText
end tell`;
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
		const searchTermLiteral = asLiteral(searchTerm);

		const script = folderName
			? buildScopedSearchScript(folderName, searchTermLiteral)
			: buildUnscopedSearchScript(searchTermLiteral);

		const result = await runAppleScript(script);
		return parseDelimitedNotes(result);
	} catch (error) {
		console.error(
			`Error finding notes: ${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
}

function buildUnscopedSearchScript(searchTermLiteral: string): string {
	const excludedNamesList = EXCLUDED_FOLDERS.map(asLiteral).join(", ");
	const fieldSepLit = asLiteral(FIELD_SEP);
	const recordSepLit = asLiteral(RECORD_SEP);

	return `
tell application "Notes"
    set fieldSep to ${fieldSepLit}
    set recordSep to ${recordSepLit}
    set outText to ""
    set noteCount to 0
    set searchTerm to ${searchTermLiteral}
    set excludedFolders to {${excludedNamesList}}

    set allFolders to folders
    repeat with currentFolder in allFolders
        if noteCount ≥ ${CONFIG.MAX_NOTES} then exit repeat

        set thisFolderName to name of currentFolder
        if excludedFolders does not contain thisFolderName then
            try
                set folderNotes to notes of currentFolder
                repeat with i from 1 to (count of folderNotes)
                    if noteCount ≥ ${CONFIG.MAX_NOTES} then exit repeat
                    try
                        set currentNote to item i of folderNotes
                        set noteName to name of currentNote
                        set noteContent to plaintext of currentNote

                        if (noteName contains searchTerm) or (noteContent contains searchTerm) then
                            if (length of noteContent) > ${CONFIG.MAX_CONTENT_PREVIEW} then
                                set noteContent to (characters 1 thru ${CONFIG.MAX_CONTENT_PREVIEW} of noteContent) as string
                                set noteContent to noteContent & "..."
                            end if

                            set outText to outText & noteName & fieldSep & noteContent & recordSep
                            set noteCount to noteCount + 1
                        end if
                    on error
                    end try
                end repeat
            on error
            end try
        end if
    end repeat

    return outText
end tell`;
}

function buildScopedSearchScript(folderName: string, searchTermLiteral: string): string {
	const folderLiteral = asLiteral(folderName);
	const fieldSepLit = asLiteral(FIELD_SEP);
	const recordSepLit = asLiteral(RECORD_SEP);

	return `
tell application "Notes"
    set fieldSep to ${fieldSepLit}
    set recordSep to ${recordSepLit}
    set outText to ""
    set noteCount to 0
    set searchTerm to ${searchTermLiteral}
    set targetName to ${folderLiteral}

    set matchingFolders to {}
    try
        set allFolders to folders
        repeat with currentFolder in allFolders
            try
                if name of currentFolder is targetName then
                    set matchingFolders to matchingFolders & {currentFolder}
                end if
            on error
            end try
        end repeat
    on error
    end try

    if (count of matchingFolders) is 0 then
        return outText
    end if

    repeat with currentFolder in matchingFolders
        if noteCount ≥ ${CONFIG.MAX_NOTES} then exit repeat
        try
            set folderNotes to notes of currentFolder
            repeat with i from 1 to (count of folderNotes)
                if noteCount ≥ ${CONFIG.MAX_NOTES} then exit repeat
                try
                    set currentNote to item i of folderNotes
                    set noteName to name of currentNote
                    set noteContent to plaintext of currentNote

                    if (noteName contains searchTerm) or (noteContent contains searchTerm) then
                        if (length of noteContent) > ${CONFIG.MAX_CONTENT_PREVIEW} then
                            set noteContent to (characters 1 thru ${CONFIG.MAX_CONTENT_PREVIEW} of noteContent) as string
                            set noteContent to noteContent & "..."
                        end if

                        set outText to outText & noteName & fieldSep & noteContent & recordSep
                        set noteCount to noteCount + 1
                    end if
                on error
                end try
            end repeat
        on error
        end try
    end repeat

    return outText
end tell`;
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
