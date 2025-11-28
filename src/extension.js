import * as vscode from 'vscode';
import { EXTENSION_NAME, EXTENSION_ID } from './lib/constants.js';
import * as statusBarService from './services/status-bar.js';
import * as sourceTracking from './services/source-tracking.js';
import * as fileDecorations from './services/file-decorations.js';
import * as codeCoverage from './services/code-coverage.js';
import * as sfCli from './lib/sf-cli.js';

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
    this.cliInstalled = false;
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
      console.log(`${EXTENSION_NAME}: SFDX project detected, checking prerequisites...`);

      // Check if SF CLI is installed
      const cliStatus = await sfCli.checkSfCliInstalled();
      this.cliInstalled = cliStatus.installed;
      await vscode.commands.executeCommand('setContext', 'sfMetadataTracker:cli_installed', this.cliInstalled);

      if (!this.cliInstalled) {
        console.log(`${EXTENSION_NAME}: Salesforce CLI not found`);
        sfCli.promptInstallCli();
        return;
      }

      console.log(`${EXTENSION_NAME}: CLI found, activating features`);

      // Initialize status bar
      statusBarService.initialize(this.context);

      // Initialize file decorations for sync status
      fileDecorations.initialize(this.context);

      // Initialize code coverage service
      codeCoverage.initialize(this.context);

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
      // Check CLI first
      const cliStatus = await sfCli.checkSfCliInstalled();
      this.cliInstalled = cliStatus.installed;
      await vscode.commands.executeCommand('setContext', 'sfMetadataTracker:cli_installed', this.cliInstalled);

      if (!this.cliInstalled) {
        sfCli.promptInstallCli();
        return;
      }

      // Activate features
      statusBarService.initialize(this.context);
      fileDecorations.initialize(this.context);
      codeCoverage.initialize(this.context);
      vscode.window.showInformationMessage(
        `${EXTENSION_NAME}: Salesforce DX project detected! Features activated.`
      );
    } else {
      // Hide/dispose features when leaving SFDX project
      statusBarService.dispose();
      fileDecorations.dispose();
      codeCoverage.dispose();
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
            const filePath = editor.document.uri.fsPath;
            
            // Show syncing status
            statusBarService.showSyncingStatus();
            
            // Clear cache and force re-fetch from org
            sourceTracking.invalidateFileCache(filePath);
            sourceTracking.clearOrgCache();
            
            // Fetch fresh status from org
            await statusBarService.updateSyncStatus(filePath);
            fileDecorations.refreshFile(editor.document.uri);
          }
        },
      },
      {
        command: `${EXTENSION_ID}.refreshAllFileStatus`,
        callback: async () => {
          // Show syncing status
          statusBarService.showSyncingStatus();
          
          // Clear all caches
          sourceTracking.clearSourceCache();
          sourceTracking.clearOrgCache();
          sourceTracking.clearChangesCache();
          
          // Trigger full refresh (will re-check local changes and re-prefetch all files)
          await fileDecorations.refreshAll(true);
          
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            await statusBarService.updateSyncStatus(editor.document.uri.fsPath);
          }
        },
      },
      {
        command: `${EXTENSION_ID}.deployCurrentFile`,
        callback: () => this.deployCurrentFile(),
      },
      {
        command: `${EXTENSION_ID}.retrieveCurrentFile`,
        callback: () => this.retrieveCurrentFile(),
      },
      {
        command: `${EXTENSION_ID}.authorizeOrg`,
        callback: () => this.authorizeOrg(),
      },
      {
        command: `${EXTENSION_ID}.switchOrg`,
        callback: () => this.switchOrg(),
      },
      {
        command: `${EXTENSION_ID}.toggleCoverage`,
        callback: () => codeCoverage.toggleCoverage(),
      },
      {
        command: `${EXTENSION_ID}.refreshCoverage`,
        callback: () => codeCoverage.refreshCoverage(),
      },
    ];

    commands.forEach(({ command, callback }) => {
      this.context.subscriptions.push(vscode.commands.registerCommand(command, callback));
    });
  }

  /**
   * Deploy the current file to the org
   */
  async deployCurrentFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No file is currently open.');
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const metadataInfo = sourceTracking.getMetadataTypeFromPath(filePath);
    
    if (!metadataInfo) {
      vscode.window.showWarningMessage('This is not a supported Salesforce metadata file.');
      return;
    }

    // Save the file first
    await editor.document.save();

    const terminal = vscode.window.createTerminal('SF Deploy');
    terminal.show();
    terminal.sendText(`sf project deploy start --source-dir "${filePath}"`);

    // Refresh status after a delay
    setTimeout(async () => {
      sourceTracking.invalidateFileCache(filePath);
      await statusBarService.updateSyncStatus(filePath);
      fileDecorations.refreshFile(editor.document.uri);
    }, 5000);
  }

  /**
   * Retrieve the current file from the org
   */
  async retrieveCurrentFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No file is currently open.');
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const metadataInfo = sourceTracking.getMetadataTypeFromPath(filePath);
    
    if (!metadataInfo) {
      vscode.window.showWarningMessage('This is not a supported Salesforce metadata file.');
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `This will overwrite your local changes to ${metadataInfo.name}. Continue?`,
      'Retrieve',
      'Cancel'
    );

    if (confirm !== 'Retrieve') {
      return;
    }

    const terminal = vscode.window.createTerminal('SF Retrieve');
    terminal.show();
    terminal.sendText(`sf project retrieve start --source-dir "${filePath}"`);

    // Refresh status after a delay
    setTimeout(async () => {
      sourceTracking.invalidateFileCache(filePath);
      await statusBarService.updateSyncStatus(filePath);
      fileDecorations.refreshFile(editor.document.uri);
    }, 5000);
  }

  /**
   * Authorize a new org
   */
  async authorizeOrg() {
    const authOptions = [
      { label: '$(globe) Web Login', description: 'Authorize using browser (recommended)', value: 'web' },
      { label: '$(device-desktop) Device Login', description: 'For headless environments', value: 'device' },
      { label: '$(key) JWT Login', description: 'For CI/CD and automation', value: 'jwt' },
    ];

    const selected = await vscode.window.showQuickPick(authOptions, {
      placeHolder: 'Select authorization method',
    });

    if (!selected) return;

    const terminal = vscode.window.createTerminal('SF Auth');
    terminal.show();

    switch (selected.value) {
      case 'web':
        terminal.sendText('sf org login web');
        break;
      case 'device':
        terminal.sendText('sf org login device');
        break;
      case 'jwt':
        vscode.window.showInformationMessage(
          'JWT login requires additional setup. See Salesforce CLI documentation.',
          'Open Docs'
        ).then(action => {
          if (action === 'Open Docs') {
            vscode.env.openExternal(vscode.Uri.parse('https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/sfdx_dev_auth_jwt_flow.htm'));
          }
        });
        return;
    }

    // Clear cache after auth attempt
    setTimeout(() => {
      sourceTracking.clearOrgCache();
      sourceTracking.clearSourceCache();
    }, 10000);
  }

  /**
   * Switch to a different org
   */
  async switchOrg() {
    const terminal = vscode.window.createTerminal('SF Org');
    terminal.show();
    terminal.sendText('sf org list');

    const orgAlias = await vscode.window.showInputBox({
      prompt: 'Enter the alias or username of the org to set as default',
      placeHolder: 'e.g., myDevOrg or user@example.com',
    });

    if (orgAlias) {
      terminal.sendText(`sf config set target-org ${orgAlias}`);
      
      // Clear caches
      sourceTracking.clearOrgCache();
      sourceTracking.clearSourceCache();
      fileDecorations.refreshAll();
      
      vscode.window.showInformationMessage(`Default org set to: ${orgAlias}`);
    }
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
  codeCoverage.dispose();
}
