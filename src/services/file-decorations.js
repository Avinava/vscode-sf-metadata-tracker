import * as vscode from 'vscode';
import * as sourceTracking from './source-tracking.js';
import * as logger from '../lib/logger.js';
import { SALESFORCE_PATHS, SALESFORCE_EXTENSIONS } from '../lib/constants.js';

/**
 * File Decoration Provider for Salesforce files
 * Shows sync status badges on files in explorer and editor tabs
 */

class SalesforceFileDecorationProvider {
  constructor() {
    this._onDidChangeFileDecorations = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    // Cache for decorations
    this._decorationCache = new Map();

    // Debounce timer for batch updates
    this._pendingUpdates = new Set();
    this._updateTimer = null;
  }

  /**
   * Get recently modified hours from settings
   * @returns {number}
   */
  _getRecentlyModifiedHours() {
    const config = vscode.workspace.getConfiguration('sfMetadataTracker');
    return config.get('recentlyModifiedHours', 24) || 24;
  }

  /**
   * Provide decoration for a file
   * @param {vscode.Uri} uri 
   * @returns {Promise<vscode.FileDecoration | undefined>}
   */
  async provideFileDecoration(uri) {
    // Check if decorations are enabled
    const config = vscode.workspace.getConfiguration('sfMetadataTracker');
    if (!config.get('showFileDecorations', true)) {
      return undefined;
    }

    const filePath = uri.fsPath;

    // Only decorate Salesforce metadata files
    if (!this._isSalesforceFile(filePath)) {
      return undefined;
    }

    // Check cache first
    const cached = this._decorationCache.get(filePath);
    if (cached && Date.now() - cached.timestamp < 60000) {
      return cached.decoration;
    }

    // Check org connection (use cached if available)
    const orgStatus = sourceTracking.getCachedOrgConnection();
    if (!orgStatus.connected) {
      // Don't show decoration if not connected
      return undefined;
    }

    // For meta.xml files, get the status of the parent file
    const queryFilePath = this._getParentFilePath(filePath);
    
    // Get file status (this uses its own cache)
    const fileStatus = await sourceTracking.getFileOrgStatus(queryFilePath);

    let decoration;

    if (fileStatus.error === 'Component not found in org') {
      // New file - not in org yet (Green + plus sign)
      decoration = new vscode.FileDecoration(
        '+', // Badge: plus for new
        '✨ New - Not deployed to org yet',
        new vscode.ThemeColor('gitDecoration.untrackedResourceForeground') // Green
      );
    } else if (fileStatus.error) {
      // Error checking - skip decoration
      return undefined;
    } else if (fileStatus.lastModifiedBy) {
      // File exists in org - check if it's in sync
      const timeAgo = sourceTracking.formatDate(fileStatus.lastModifiedDate);
      const lastModifiedDate = new Date(fileStatus.lastModifiedDate);
      const recentlyModifiedHours = this._getRecentlyModifiedHours();
      const hoursSinceModified = (Date.now() - lastModifiedDate.getTime()) / (1000 * 60 * 60);

      // Check if modified recently by someone (potential conflict warning)
      if (hoursSinceModified < recentlyModifiedHours) {
        // Recently modified - show warning color (someone may have changed it)
        decoration = new vscode.FileDecoration(
          '!', // Badge: exclamation for recent changes
          `⚠️ Recently modified by ${fileStatus.lastModifiedBy} (${timeAgo}) - Consider pulling latest`,
          new vscode.ThemeColor('editorWarning.foreground') // Orange/Yellow warning
        );
      } else {
        // In sync - show subtle indicator (checkmark)
        decoration = new vscode.FileDecoration(
          '✓', // Badge: checkmark for synced
          `✅ In sync • Last modified by ${fileStatus.lastModifiedBy} (${timeAgo})`,
          new vscode.ThemeColor('gitDecoration.ignoredResourceForeground') // Subtle gray
        );
      }
    }

    // Cache the decoration
    if (decoration) {
      this._decorationCache.set(filePath, {
        timestamp: Date.now(),
        decoration,
      });
    }

    return decoration;
  }

  /**
   * Check if file is a meta.xml file
   * @param {string} filePath 
   * @returns {boolean}
   */
  _isMetaFile(filePath) {
    return filePath.endsWith('-meta.xml');
  }

  /**
   * Get the parent file path for a meta.xml file
   * @param {string} filePath 
   * @returns {string}
   */
  _getParentFilePath(filePath) {
    // If it's a meta file like "MyClass.cls-meta.xml", return "MyClass.cls"
    if (this._isMetaFile(filePath)) {
      return filePath.replace('-meta.xml', '');
    }
    return filePath;
  }

  /**
   * Check if file is a Salesforce metadata file
   * @param {string} filePath 
   * @returns {boolean}
   */
  _isSalesforceFile(filePath) {
    if (!filePath) return false;

    const isInSfPath = SALESFORCE_PATHS.some((p) => filePath.includes(p));
    const hasSfExtension = SALESFORCE_EXTENSIONS.some((ext) => filePath.endsWith(ext));

    return isInSfPath && hasSfExtension;
  }

  /**
   * Refresh decoration for a specific file
   * @param {vscode.Uri} uri 
   */
  refresh(uri) {
    if (uri) {
      this._decorationCache.delete(uri.fsPath);
      this._onDidChangeFileDecorations.fire(uri);
    }
  }

  /**
   * Refresh all decorations
   */
  refreshAll() {
    this._decorationCache.clear();
    this._onDidChangeFileDecorations.fire(undefined);
  }

  /**
   * Queue a file for decoration update (debounced)
   * @param {vscode.Uri} uri 
   */
  queueRefresh(uri) {
    this._pendingUpdates.add(uri);

    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
    }

    this._updateTimer = setTimeout(() => {
      for (const pendingUri of this._pendingUpdates) {
        this.refresh(pendingUri);
      }
      this._pendingUpdates.clear();
    }, 500);
  }

  /**
   * Clear cache for a file
   * @param {string} filePath 
   */
  invalidateCache(filePath) {
    this._decorationCache.delete(filePath);
  }

  /**
   * Check if a file is a Salesforce file (public accessor)
   * @param {string} filePath 
   * @returns {boolean}
   */
  isSalesforceFile(filePath) {
    return this._isSalesforceFile(filePath);
  }

  /**
   * Dispose the provider
   */
  dispose() {
    this._onDidChangeFileDecorations.dispose();
    this._decorationCache.clear();
    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
    }
  }
}

// Singleton instance
let decorationProvider = null;
let disposables = [];

/**
 * Initialize the file decoration provider
 * @param {vscode.ExtensionContext} context 
 */
export function initialize(context) {
  if (decorationProvider) {
    return decorationProvider;
  }

  decorationProvider = new SalesforceFileDecorationProvider();

  // Register the provider
  const registration = vscode.window.registerFileDecorationProvider(decorationProvider);
  context.subscriptions.push(registration);

  // Watch for file saves to refresh decorations
  const saveWatcher = vscode.workspace.onDidSaveTextDocument((document) => {
    if (decorationProvider._isSalesforceFile(document.uri.fsPath)) {
      // Invalidate source tracking cache too
      sourceTracking.invalidateFileCache(document.uri.fsPath);
      decorationProvider.queueRefresh(document.uri);
    }
  });
  context.subscriptions.push(saveWatcher);

  // Watch for active editor to trigger initial decoration
  const editorWatcher = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor && decorationProvider._isSalesforceFile(editor.document.uri.fsPath)) {
      decorationProvider.queueRefresh(editor.document.uri);
    }
  });
  context.subscriptions.push(editorWatcher);

  disposables.push(registration, saveWatcher, editorWatcher);

  logger.log('File decoration provider initialized');

  return decorationProvider;
}

/**
 * Get the decoration provider instance
 * @returns {SalesforceFileDecorationProvider | null}
 */
export function getProvider() {
  return decorationProvider;
}

/**
 * Refresh decoration for a specific file
 * @param {vscode.Uri} uri 
 */
export function refreshFile(uri) {
  if (decorationProvider) {
    decorationProvider.refresh(uri);
  }
}

/**
 * Refresh all file decorations
 */
export function refreshAll() {
  if (decorationProvider) {
    decorationProvider.refreshAll();
  }
}

/**
 * Dispose the file decoration provider
 */
export function dispose() {
  if (decorationProvider) {
    decorationProvider.dispose();
    decorationProvider = null;
  }
  disposables.forEach((d) => d.dispose());
  disposables = [];
}
