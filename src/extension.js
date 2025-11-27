import * as vscode from 'vscode';
import { EXTENSION_NAME, EXTENSION_ID } from './lib/constants.js';
import * as statusBarService from './services/status-bar.js';
import * as sourceTracking from './services/source-tracking.js';
import * as fileDecorations from './services/file-decorations.js';

/**
 * Check if current workspace is a Salesforce DX project
 * @returns {Promise<boolean>}
 */
async function isSalesforceDXProject() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return false;
  }

  try {
    const files = await vscode.workspace.findFiles('sfdx-project.json', null, 1);
    return files.length > 0;
  } catch {
    return false;
  }
}

/**
 * Main extension class
 */
class Extension {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this.context = context;
    this.isSfdxProject = false;
  }

  /**
   * Activate the extension
   */
  async activate() {
    console.log(`Congratulations, your extension "${EXTENSION_NAME}" is now active!`);

    // Check if we're in an SFDX project and set context
    this.isSfdxProject = await isSalesforceDXProject();
    await vscode.commands.executeCommand('setContext', 'sfMetadataTracker:project_opened', this.isSfdxProject);

    // Always register commands (they'll be hidden via when clauses if not in SFDX project)
    this.registerCommands();

    // Only run features when in a Salesforce project
    if (this.isSfdxProject) {
      console.log(`${EXTENSION_NAME}: SFDX project detected, activating features`);

      // Initialize status bar
      statusBarService.initialize(this.context);

      // Initialize file decorations for sync status
      fileDecorations.initialize(this.context);

      // Watch for sfdx-project.json changes
      this.watchSfdxProject();
    } else {
      console.log(`${EXTENSION_NAME}: Not an SFDX project, features disabled`);
    }

    // Watch for workspace folder changes to detect new SFDX projects
    this.watchWorkspaceChanges();
  }

  /**
   * Watch for changes to sfdx-project.json
   */
  watchSfdxProject() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/sfdx-project.json');

    watcher.onDidCreate(async () => {
      console.log(`${EXTENSION_NAME}: sfdx-project.json created`);
      await this.handleSfdxProjectChange(true);
    });

    watcher.onDidDelete(async () => {
      console.log(`${EXTENSION_NAME}: sfdx-project.json deleted`);
      await this.handleSfdxProjectChange(false);
    });

    this.context.subscriptions.push(watcher);
  }

  /**
   * Watch for workspace folder changes
   */
  watchWorkspaceChanges() {
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      const isSfdx = await isSalesforceDXProject();
      if (isSfdx !== this.isSfdxProject) {
        await this.handleSfdxProjectChange(isSfdx);
      }
    });
  }

  /**
   * Handle SFDX project status change
   * @param {boolean} isSfdxProject
   */
  async handleSfdxProjectChange(isSfdxProject) {
    this.isSfdxProject = isSfdxProject;
    await vscode.commands.executeCommand('setContext', 'sfMetadataTracker:project_opened', this.isSfdxProject);

    if (this.isSfdxProject) {
      // Activate features
      statusBarService.initialize(this.context);
      fileDecorations.initialize(this.context);
      vscode.window.showInformationMessage(
        `${EXTENSION_NAME}: Salesforce DX project detected! Features activated.`
      );
    } else {
      // Hide/dispose features when leaving SFDX project
      statusBarService.dispose();
      fileDecorations.dispose();
    }
  }

  /**
   * Register all extension commands
   */
  registerCommands() {
    const commands = [
      {
        command: `${EXTENSION_ID}.showFileOrgStatus`,
        callback: () => statusBarService.showFileOrgStatusDetails(),
      },
      {
        command: `${EXTENSION_ID}.refreshFileStatus`,
        callback: async () => {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            sourceTracking.invalidateFileCache(editor.document.uri.fsPath);
            await statusBarService.updateSyncStatus(editor.document.uri.fsPath);
            fileDecorations.refreshFile(editor.document.uri);
            vscode.window.showInformationMessage('File status refreshed!');
          }
        },
      },
      {
        command: `${EXTENSION_ID}.refreshAllFileStatus`,
        callback: async () => {
          sourceTracking.clearSourceCache();
          fileDecorations.refreshAll();
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            await statusBarService.updateSyncStatus(editor.document.uri.fsPath);
          }
          vscode.window.showInformationMessage('All file statuses refreshed!');
        },
      },
    ];

    commands.forEach(({ command, callback }) => {
      this.context.subscriptions.push(vscode.commands.registerCommand(command, callback));
    });
  }

  /**
   * Deactivate the extension
   */
  deactivate() {
    statusBarService.dispose();
    fileDecorations.dispose();
  }
}

/**
 * Extension activation entry point
 * @param {vscode.ExtensionContext} context
 */
export function activate(context) {
  const extension = new Extension(context);
  extension.activate();
}

/**
 * Extension deactivation entry point
 */
export function deactivate() {
  statusBarService.dispose();
  fileDecorations.dispose();
}
