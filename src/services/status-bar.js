import * as vscode from 'vscode';
import * as sourceTracking from './source-tracking.js';
import { EXTENDED_SALESFORCE_PATHS } from '../lib/constants.js';

// Status bar icons using codicons
const SYNC_ICON = '$(sync)';
const SYNC_SPIN_ICON = '$(sync~spin)';
const WARNING_ICON = '$(warning)';
const CLOUD_ICON = '$(cloud)';

/**
 * Status bar service
 * Manages the file sync status bar item
 */

let syncStatusBarItem = null;
let prefetchStatusBarItem = null;
let activeFileWatcher = null;
let isPrefetching = false;

/**
 * Initialize the status bar item
 * @param {vscode.ExtensionContext} context
 * @returns {vscode.StatusBarItem}
 */
export function initialize(context) {
  // Sync status bar item (shows org connection + file sync status)
  syncStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  syncStatusBarItem.command = 'sf-metadata-tracker.showFileOrgStatus';
  syncStatusBarItem.name = 'SF Metadata Tracker';
  context.subscriptions.push(syncStatusBarItem);

  // Prefetch status bar item (shows background loading progress)
  prefetchStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99
  );
  prefetchStatusBarItem.name = 'SF Metadata Tracker - Loading';
  context.subscriptions.push(prefetchStatusBarItem);

  // Watch for active editor changes to update sync status
  activeFileWatcher = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
    if (editor) {
      await updateSyncStatus(editor.document.uri.fsPath);
    } else {
      hideSyncStatus();
    }
  });
  context.subscriptions.push(activeFileWatcher);

  // Update sync status for current file if any
  if (vscode.window.activeTextEditor) {
    updateSyncStatus(vscode.window.activeTextEditor.document.uri.fsPath);
  }

  return syncStatusBarItem;
}

/**
 * Check if file is a Salesforce metadata file
 * @param {string} filePath 
 * @returns {boolean}
 */
function isSalesforceFile(filePath) {
  if (!filePath) return false;
  return EXTENDED_SALESFORCE_PATHS.some((p) => filePath.includes(p));
}

/**
 * Update the sync status bar for a specific file
 * @param {string} filePath - Path to the current file
 */
export async function updateSyncStatus(filePath) {
  if (!syncStatusBarItem) return;

  // Check if status bar is enabled in settings
  const config = vscode.workspace.getConfiguration('sfMetadataTracker');
  if (!config.get('showStatusBar', true)) {
    syncStatusBarItem.hide();
    return;
  }

  // Check if it's a Salesforce metadata file
  if (!isSalesforceFile(filePath)) {
    hideSyncStatus();
    return;
  }

  // Show loading state
  syncStatusBarItem.text = `${SYNC_ICON} Checking...`;
  syncStatusBarItem.tooltip = 'Checking org status...';
  syncStatusBarItem.backgroundColor = undefined;
  syncStatusBarItem.color = undefined;
  syncStatusBarItem.show();

  // First check if org is connected
  const orgStatus = await sourceTracking.checkOrgConnection();

  if (!orgStatus.connected) {
    syncStatusBarItem.text = `$(plug) No Org`;
    syncStatusBarItem.tooltip = 'No org connected. Click to connect.';
    syncStatusBarItem.backgroundColor = undefined;
    syncStatusBarItem.color = new vscode.ThemeColor('disabledForeground');
    return;
  }

  // Get file status from org
  const fileStatus = await sourceTracking.getFileOrgStatus(filePath);

  if (fileStatus.error) {
    if (fileStatus.error === 'Not a Salesforce metadata file') {
      hideSyncStatus();
      return;
    }

    if (fileStatus.error === 'Component not found in org') {
      syncStatusBarItem.text = `$(new-file) New`;
      syncStatusBarItem.tooltip = `This component doesn't exist in the org yet.\nOrg: ${orgStatus.alias || orgStatus.username}`;
      syncStatusBarItem.backgroundColor = undefined;
      syncStatusBarItem.color = new vscode.ThemeColor('charts.green');
      return;
    }

    syncStatusBarItem.text = `${WARNING_ICON} Unknown`;
    syncStatusBarItem.tooltip = `Could not check status: ${fileStatus.error}`;
    syncStatusBarItem.backgroundColor = undefined;
    syncStatusBarItem.color = new vscode.ThemeColor('charts.yellow');
    return;
  }

  // Show the status with last modified info
  syncStatusBarItem.text = `$(account) ${fileStatus.lastModifiedBy || 'Unknown'}`;
  syncStatusBarItem.tooltip = buildFileStatusTooltip(fileStatus, orgStatus);
  syncStatusBarItem.backgroundColor = undefined;
  syncStatusBarItem.color = new vscode.ThemeColor('charts.blue');
}

/**
 * Build tooltip for file status
 * @param {Object} fileStatus 
 * @param {Object} orgStatus 
 * @returns {string}
 */
function buildFileStatusTooltip(fileStatus, orgStatus) {
  const lines = [
    `📁 ${fileStatus.type}: ${fileStatus.name}`,
    ``,
    `🔗 Org: ${orgStatus.alias || orgStatus.username}`,
    ``,
    `✏️ Last Modified:`,
    `   By: ${fileStatus.lastModifiedBy || 'Unknown'}`,
    `   On: ${formatFullDate(fileStatus.lastModifiedDate)}`,
  ];

  if (fileStatus.createdBy) {
    lines.push(
      ``,
      `📝 Created:`,
      `   By: ${fileStatus.createdBy}`,
      `   On: ${formatFullDate(fileStatus.createdDate)}`
    );
  }

  lines.push(``, `Click for more details`);

  return lines.join('\n');
}

/**
 * Format date for tooltip
 * @param {string} dateString 
 * @returns {string}
 */
function formatFullDate(dateString) {
  if (!dateString) return 'Unknown';
  const date = new Date(dateString);
  return date.toLocaleString();
}

/**
 * Hide the sync status bar
 */
export function hideSyncStatus() {
  if (syncStatusBarItem) {
    syncStatusBarItem.hide();
  }
}

/**
 * Show detailed file org status in a message
 */
export async function showFileOrgStatusDetails() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('No file is currently open.');
    return;
  }

  const filePath = editor.document.uri.fsPath;

  // Check org connection first
  const orgStatus = await sourceTracking.checkOrgConnection();
  if (!orgStatus.connected) {
    const action = await vscode.window.showWarningMessage(
      'No org is connected. Would you like to authorize an org?',
      'Authorize Org',
      'Cancel'
    );
    if (action === 'Authorize Org') {
      const terminal = vscode.window.createTerminal('SF Auth');
      terminal.show();
      terminal.sendText('sf org login web');
    }
    return;
  }

  // Get file status
  const fileStatus = await sourceTracking.getFileOrgStatus(filePath);

  if (fileStatus.error) {
    vscode.window.showInformationMessage(fileStatus.error);
    return;
  }

  // Show detailed info
  const items = [
    {
      label: `$(account) Last Modified By: ${fileStatus.lastModifiedBy}`,
      description: formatFullDate(fileStatus.lastModifiedDate),
    },
    {
      label: `$(calendar) Created By: ${fileStatus.createdBy}`,
      description: formatFullDate(fileStatus.createdDate),
    },
    {
      label: `$(cloud) Org: ${orgStatus.alias || orgStatus.username}`,
      description: orgStatus.instanceUrl,
    },
    {
      label: '$(refresh) Refresh Status',
      description: 'Clear cache and recheck',
      action: 'refresh',
    },
    {
      label: '$(globe) Open in Org',
      description: 'Open this component in the browser',
      action: 'open',
    },
  ];

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `${fileStatus.type}: ${fileStatus.name}`,
  });

  if (selected?.action === 'refresh') {
    sourceTracking.invalidateFileCache(filePath);
    await updateSyncStatus(filePath);
    vscode.window.showInformationMessage('Status refreshed!');
  } else if (selected?.action === 'open') {
    const terminal = vscode.window.createTerminal('SF Open');
    terminal.show();
    terminal.sendText('sf org open');
  }
}

/**
 * Get the sync status bar item
 * @returns {vscode.StatusBarItem | null}
 */
export function getSyncStatusBarItem() {
  return syncStatusBarItem;
}

/**
 * Show prefetch progress in status bar
 * @param {number} current - Current file index
 * @param {number} total - Total number of files
 */
export function showPrefetchProgress(current, total) {
  if (!prefetchStatusBarItem) return;
  
  isPrefetching = true;
  const percentage = Math.round((current / total) * 100);
  prefetchStatusBarItem.text = `${SYNC_SPIN_ICON} Syncing ${current}/${total} (${percentage}%)`;
  prefetchStatusBarItem.tooltip = `SF Metadata Tracker: Loading file statuses from org...\n${current} of ${total} files processed`;
  prefetchStatusBarItem.backgroundColor = undefined;
  prefetchStatusBarItem.color = new vscode.ThemeColor('charts.blue');
  prefetchStatusBarItem.show();
}

/**
 * Hide prefetch progress
 * @param {number} total - Total files processed
 */
export function hidePrefetchProgress(total) {
  if (!prefetchStatusBarItem) return;
  
  isPrefetching = false;
  
  // Show completion message briefly
  prefetchStatusBarItem.text = `${CLOUD_ICON} ${total} files synced`;
  prefetchStatusBarItem.tooltip = `SF Metadata Tracker: All file statuses loaded`;
  prefetchStatusBarItem.color = new vscode.ThemeColor('charts.green');
  
  // Hide after 3 seconds
  setTimeout(() => {
    if (prefetchStatusBarItem && !isPrefetching) {
      prefetchStatusBarItem.hide();
    }
  }, 3000);
}

/**
 * Check if prefetch is in progress
 * @returns {boolean}
 */
export function isPrefetchInProgress() {
  return isPrefetching;
}

/**
 * Dispose status bar resources
 */
export function dispose() {
  if (syncStatusBarItem) {
    syncStatusBarItem.dispose();
    syncStatusBarItem = null;
  }
  if (prefetchStatusBarItem) {
    prefetchStatusBarItem.dispose();
    prefetchStatusBarItem = null;
  }
  if (activeFileWatcher) {
    activeFileWatcher.dispose();
    activeFileWatcher = null;
  }
}
