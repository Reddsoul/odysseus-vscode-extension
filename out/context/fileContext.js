"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getActiveFileContext = getActiveFileContext;
exports.getSelectionContext = getSelectionContext;
exports.getWorkspaceRoot = getWorkspaceRoot;
exports.buildDisplayMessage = buildDisplayMessage;
exports.buildApiMessage = buildApiMessage;
exports.buildMessageWithContext = buildMessageWithContext;
exports.fileTitle = fileTitle;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const MAX_CHARS = 20000;
function getActiveFileContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return null;
    }
    const doc = editor.document;
    const full = doc.getText();
    const truncated = full.length > MAX_CHARS;
    return {
        filePath: doc.fileName,
        language: doc.languageId,
        content: truncated ? full.slice(0, MAX_CHARS) : full,
        truncated,
    };
}
function getSelectionContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
        return null;
    }
    const doc = editor.document;
    const sel = editor.selection;
    return {
        text: doc.getText(sel),
        startLine: sel.start.line + 1,
        endLine: sel.end.line + 1,
        language: doc.languageId,
    };
}
function getWorkspaceRoot() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}
function buildDisplayMessage(userMessage, selection) {
    if (!selection) {
        return userMessage;
    }
    const lineRange = selection.startLine === selection.endLine
        ? `line ${selection.startLine}`
        : `lines ${selection.startLine}–${selection.endLine}`;
    return (userMessage +
        `\n\nSelected (${lineRange}):\n\`\`\`${selection.language}\n${selection.text}\n\`\`\``);
}
/** Builds the message sent to the API — includes workspace context the model needs but the user doesn't need to see. */
function buildApiMessage(displayMessage, workspaceRoot, fileCtx) {
    const lines = [];
    if (workspaceRoot) {
        lines.push(`<vscode_workspace>`);
        lines.push(`working_directory: ${workspaceRoot}`);
        if (fileCtx) {
            lines.push(`active_file: ${fileCtx.filePath}`);
            lines.push(`language: ${fileCtx.language}`);
        }
        // List top-level files so the model can navigate the project
        try {
            const { readdirSync, statSync } = require("fs");
            const entries = readdirSync(workspaceRoot)
                .filter((f) => !f.startsWith(".") && f !== "node_modules" && f !== "__pycache__")
                .slice(0, 40);
            lines.push(`files: ${entries.join(", ")}`);
        }
        catch { /* ignore */ }
        lines.push(`</vscode_workspace>`);
        lines.push(`<instructions>`);
        lines.push(`You are an AI coding assistant running inside VS Code, connected to a local Odysseus instance.`);
        lines.push(`The working_directory above is a REAL path on the local filesystem of this machine.`);
        lines.push(`IMPORTANT — when the user asks you to create, edit, or modify a file:`);
        lines.push(`  1. Use the write_file tool with the FULL absolute path (e.g. ${workspaceRoot}/README.md).`);
        lines.push(`  2. Never output file contents as chat text when asked to edit — write to disk directly.`);
        lines.push(`  3. To read a file, use read_file with its full path.`);
        lines.push(`  4. After writing, confirm what changed in one sentence.`);
        lines.push(`</instructions>`);
        lines.push("");
    }
    lines.push(displayMessage);
    return lines.join("\n");
}
/** @deprecated use buildDisplayMessage */
function buildMessageWithContext(userMessage, selection) {
    return buildDisplayMessage(userMessage, selection);
}
function fileTitle(filePath) {
    return path.basename(filePath);
}
//# sourceMappingURL=fileContext.js.map