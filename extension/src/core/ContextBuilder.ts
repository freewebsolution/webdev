import * as vscode from 'vscode';

export class ContextBuilder {
  static async getActiveFileContext(): Promise<{ fileName: string; content: string; language: string } | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;

    const doc = editor.document;
    return {
      fileName: doc.fileName,
      content: doc.getText(),
      language: doc.languageId
    };
  }

  static async getSelectionContext(): Promise<{ fileName: string; content: string; language: string } | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) return null;

    const doc = editor.document;
    return {
      fileName: doc.fileName,
      content: doc.getText(editor.selection),
      language: doc.languageId
    };
  }

  static formatFileContext(ctx: { fileName: string; content: string; language: string }): string {
    const shortName = ctx.fileName.split('/').pop() || ctx.fileName;
    return `\`\`\`${ctx.language}\n// File: ${shortName}\n${ctx.content}\n\`\`\``;
  }
}
