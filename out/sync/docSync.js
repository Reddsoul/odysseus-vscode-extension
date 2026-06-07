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
exports.DocSync = void 0;
const vscode = __importStar(require("vscode"));
const fileContext_1 = require("../context/fileContext");
class DocSync {
    constructor(client) {
        this.fileToDocId = new Map();
        this.client = client;
    }
    reset() {
        this.fileToDocId.clear();
    }
    async syncFile(ctx, sessionId) {
        const existing = this.fileToDocId.get(ctx.filePath);
        if (existing) {
            await this.client.updateDocument(existing, ctx.content);
            return existing;
        }
        const doc = await this.client.createDocument((0, fileContext_1.fileTitle)(ctx.filePath), ctx.language, ctx.content, sessionId);
        this.fileToDocId.set(ctx.filePath, doc.id);
        return doc.id;
    }
    async applyRemoteEdits(filePath, localContent) {
        const docId = this.fileToDocId.get(filePath);
        if (!docId) {
            return;
        }
        let remote;
        try {
            remote = (await this.client.getDocument(docId));
        }
        catch {
            return;
        }
        if (remote.content === localContent) {
            return;
        }
        const uri = vscode.Uri.file(filePath);
        const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === filePath);
        if (!editor) {
            return;
        }
        const edit = new vscode.WorkspaceEdit();
        const doc = editor.document;
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        edit.replace(uri, fullRange, remote.content);
        await vscode.workspace.applyEdit(edit);
        const linesBefore = localContent.split("\n").length;
        const linesAfter = remote.content.split("\n").length;
        const diff = Math.abs(linesAfter - linesBefore);
        if (diff > 0) {
            vscode.window.setStatusBarMessage(`Odysseus edited ${diff} line${diff !== 1 ? "s" : ""}`, 4000);
        }
    }
}
exports.DocSync = DocSync;
//# sourceMappingURL=docSync.js.map