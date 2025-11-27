import * as vscode from 'vscode';
import * as sourceTracking from './source-tracking.js';
import * as statusBar from './status-bar.js';
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

    // For meta.xml files, use the parent file path for both cache and query
    const parentFilePath = this._getParentFilePath(filePath);

    // Check cache using parent file path (so .cls and .cls-meta.xml share same cache)
    const cached = this._decorationCache.get(parentFilePath);
    if (cached && Date.now() - cached.timestamp < 60000) {
      return cached.decoration;
    }

    // Check org connection (use cached if available)
    const orgStatus = sourceTracking.getCachedOrgConnection();
    if (!orgStatus.connected) {
      // Don't show decoration if not connected
      return undefined;
    }
    
    // Get file status (this uses its own cache)
    const fileStatus = await sourceTracking.getFileOrgStatus(parentFilePath);

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

    // Cache the decoration using parent file path
    if (decoration) {
      this._decorationCache.set(parentFilePath, {
        timestamp: Date.now(),
        decoration,
      });
    }

    return decoration;
  }

  /**
   * Get the parent file path for a meta.xml file
   * @param {string} filePath 
   * @returns {string}
   */
  _getParentFilePath(filePath) {
    // If it's a meta file like "MyClass.cls-meta.xml", return "MyClass.cls"
    return filePath.endsWith('-meta.xml') ? filePath.replace('-meta.xml', '') : filePath;
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
 * Pre-fetch all Salesforce files in the workspace and warm up the cache
 * This runs in the background to populate decorations for all files
 * Uses batch queries to fetch multiple files of the same type in a single API call
 */
async function prefetchAllSalesforceFiles() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return;

  logger.log('Starting prefetch of Salesforce file statuses...');

  // Find all Salesforce files
  const patterns = [
    '**/classes/*.cls',
    '**/triggers/*.trigger',
    '**/lwc/**/*.js',
    '**/aura/**/*.js',
    '**/pages/*.page',
    '**/components/*.component',
  ];

  const allFiles = [];
  for (const pattern of patterns) {
    const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 500);
    allFiles.push(...files);
  }

  logger.log(`Found ${allFiles.length} Salesforce files to prefetch`);

  if (allFiles.length === 0) {
    return;
  }

  // Show initial progress
  statusBar.showPrefetchProgress(0, allFiles.length);

  // Group files by metadata type for batch queries
  const filesByType = new Map();
  
  for (const uri of allFiles) {
    const metadataInfo = sourceTracking.getMetadataTypeFromPath(uri.fsPath);
    if (metadataInfo) {
      if (!filesByType.has(metadataInfo.type)) {
        filesByType.set(metadataInfo.type, []);
      }
      filesByType.get(metadataInfo.type).push({
        uri,
        filePath: uri.fsPath,
        name: metadataInfo.name,
      });
    }
  }

  let processedCount = 0;
  const batchSize = 50; // Query up to 50 items of the same type at once

  // Process each metadata type
  for (const [metadataType, files] of filesByType) {
    // Process in batches within each type
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      
      try {
        // Use batch query to fetch all files of this type at once
        await sourceTracking.batchGetFileOrgStatus(metadataType, batch);
      } catch (error) {
        logger.log(`Batch query failed for ${metadataType}: ${error.message}`, 'WARN');
      }

      // Update progress
      processedCount += batch.length;
      statusBar.showPrefetchProgress(processedCount, allFiles.length);

      // Fire decoration change events for the batch (both main file and meta file)
      batch.forEach(({ uri }) => {
        if (decorationProvider) {
          // Fire for the main file
          decorationProvider._onDidChangeFileDecorations.fire(uri);
          // Fire for the meta file too (e.g., .cls-meta.xml)
          const metaUri = vscode.Uri.file(uri.fsPath + '-meta.xml');
          decorationProvider._onDidChangeFileDecorations.fire(metaUri);
        }
      });

      // Small delay between batches to avoid overwhelming the org
      if (i + batchSize < files.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  // Hide progress and show completion
  statusBar.hidePrefetchProgress(allFiles.length);
  logger.log('Prefetch complete');
}

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

  // Start background prefetch after a short delay
  // This allows VS Code to finish loading before we start querying
  setTimeout(() => {
    prefetchAllSalesforceFiles().catch((error) => {
      logger.log(`Prefetch error: ${error.message}`, 'WARN');
    });
  }, 3000);

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
