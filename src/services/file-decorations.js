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
    
    // Get diff status from cache (populated by batch comparison)
    const diffStatus = sourceTracking.getFileDiffStatus(filePath) || 
                       sourceTracking.getFileDiffStatus(parentFilePath);
    
    // Get file status - try to use cached status first to avoid redundant queries
    const fileStatus = await sourceTracking.getFileOrgStatus(parentFilePath, true);

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
    } else if (diffStatus.hasDifference && diffStatus.isOrgNewer) {
      // Org has newer version - needs to be pulled (Red download arrow)
      const timeAgo = sourceTracking.formatDate(fileStatus.lastModifiedDate);
      decoration = new vscode.FileDecoration(
        '↓', // Badge: down arrow for pull needed
        `⬇️ Org has newer version • Modified by ${fileStatus.lastModifiedBy} (${timeAgo}) - Pull to update local`,
        new vscode.ThemeColor('gitDecoration.deletedResourceForeground') // Red
      );
    } else if (diffStatus.hasDifference) {
      // Local has changes - needs to be pushed (Yellow warning)
      const timeAgo = sourceTracking.formatDate(fileStatus.lastModifiedDate);
      decoration = new vscode.FileDecoration(
        '↑', // Badge: up arrow for push needed
        `⬆️ Local changes • Push to update org (last org version by ${fileStatus.lastModifiedBy}, ${timeAgo})`,
        new vscode.ThemeColor('gitDecoration.modifiedResourceForeground') // Yellow/Orange
      );
    } else if (diffStatus.isCompared && fileStatus.lastModifiedBy) {
      // File has been compared and is in sync
      const timeAgo = sourceTracking.formatDate(fileStatus.lastModifiedDate);
      decoration = new vscode.FileDecoration(
        '✓', // Badge: checkmark for synced
        `☁️ In sync with org • Last modified by ${fileStatus.lastModifiedBy} (${timeAgo})`,
        new vscode.ThemeColor('gitDecoration.ignoredResourceForeground') // Subtle gray
      );
    }
    // Note: If not compared yet, we don't show any decoration (no premature checkmarks)

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
 * Uses a pipelined approach: metadata query + content comparison run in parallel
 * As soon as a batch's metadata is fetched, its content comparison starts immediately
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

  // Group files by metadata type for batch queries, deduplicating by name+type
  const filesByType = new Map();
  const seenFiles = new Set(); // Track unique name+type combinations
  
  for (const uri of allFiles) {
    const metadataInfo = sourceTracking.getMetadataTypeFromPath(uri.fsPath);
    if (metadataInfo) {
      // Deduplicate by type+name to avoid redundant queries
      const uniqueKey = `${metadataInfo.type}:${metadataInfo.name}`;
      if (seenFiles.has(uniqueKey)) {
        continue; // Skip duplicates
      }
      seenFiles.add(uniqueKey);
      
      if (!filesByType.has(metadataInfo.type)) {
        filesByType.set(metadataInfo.type, []);
      }
      const fileInfo = {
        uri,
        filePath: uri.fsPath,
        name: metadataInfo.name,
        type: metadataInfo.type,
      };
      filesByType.get(metadataInfo.type).push(fileInfo);
    }
  }

  // Decoration callback to stream updates as each file is compared
  const onFileCompared = (uri, _hasDifference, _isOrgNewer) => {
    if (decorationProvider) {
      // Clear cache for this file and fire decoration change
      decorationProvider._decorationCache.delete(uri.fsPath);
      decorationProvider._onDidChangeFileDecorations.fire(uri);
      // Also update meta file
      const metaUri = vscode.Uri.file(uri.fsPath + '-meta.xml');
      decorationProvider._decorationCache.delete(metaUri.fsPath);
      decorationProvider._onDidChangeFileDecorations.fire(metaUri);
    }
  };

  // Track comparison promises to await at the end
  const comparisonPromises = [];
  let processedMetadataCount = 0;
  let processedCompareCount = 0;
  const totalUniqueFiles = seenFiles.size;
  const metadataBatchSize = 50; // Query up to 50 items of the same type at once
  const compareBatchSize = 10; // Compare 10 files at a time

  // Update combined progress (metadata fetch + comparison)
  const updateProgress = () => {
    // Weight: metadata = 30%, comparison = 70%
    const metadataProgress = (processedMetadataCount / totalUniqueFiles) * 0.3;
    const compareProgress = (processedCompareCount / totalUniqueFiles) * 0.7;
    const totalProgress = Math.floor((metadataProgress + compareProgress) * totalUniqueFiles);
    statusBar.showPrefetchProgress(totalProgress, totalUniqueFiles);
  };

  // Pipeline: As each metadata batch completes, immediately start comparison
  for (const [metadataType, files] of filesByType) {
    // Process in batches within each type
    for (let i = 0; i < files.length; i += metadataBatchSize) {
      const metadataBatch = files.slice(i, i + metadataBatchSize);
      
      try {
        // Fetch metadata info (timestamps, who modified)
        await sourceTracking.batchGetFileOrgStatus(metadataType, metadataBatch);
        
        // Update metadata progress
        processedMetadataCount += metadataBatch.length;
        updateProgress();
        
        // Immediately start content comparison for this batch (don't await)
        // This runs in parallel with the next metadata fetch
        const comparePromise = (async () => {
          // Split into smaller comparison batches
          for (let j = 0; j < metadataBatch.length; j += compareBatchSize) {
            const compareBatch = metadataBatch.slice(j, j + compareBatchSize);
            try {
              await sourceTracking.batchCompareFilesWithOrg(compareBatch, null, onFileCompared);
            } catch (error) {
              logger.log(`Batch compare failed: ${error.message}`, 'WARN');
            }
            processedCompareCount += compareBatch.length;
            updateProgress();
          }
        })();
        
        comparisonPromises.push(comparePromise);
        
      } catch (error) {
        logger.log(`Batch query failed for ${metadataType}: ${error.message}`, 'WARN');
        processedMetadataCount += metadataBatch.length;
        updateProgress();
      }

      // Small delay between metadata batches to avoid overwhelming the org
      if (i + metadataBatchSize < files.length) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  // Wait for all comparison batches to complete
  logger.log(`Waiting for ${comparisonPromises.length} comparison batches to complete...`);
  await Promise.all(comparisonPromises);

  // Log completion stats
  const diffCache = sourceTracking.getDiffCache();
  logger.log(`Content comparison complete. Diff cache has ${diffCache.size} entries`);
  
  // Count files by status
  const localChanges = [];
  const orgNewer = [];
  for (const [filePath, data] of diffCache.entries()) {
    if (data.hasDifference) {
      const fileName = filePath.split('/').pop();
      if (data.isOrgNewer) {
        orgNewer.push(fileName);
      } else {
        localChanges.push(fileName);
      }
    }
  }
  
  const changedCount = localChanges.length + orgNewer.length;
  if (changedCount > 0) {
    logger.log(`Found ${changedCount} files with differences`);
    localChanges.forEach(f => logger.log(`  - ${f}`));
    orgNewer.forEach(f => logger.log(`  - ${f} (org newer)`));
  } else {
    logger.log('All files are in sync with org');
  }

  // Final decoration refresh
  if (decorationProvider) {
    decorationProvider._decorationCache.clear();
    decorationProvider._onDidChangeFileDecorations.fire(undefined);
  }

  // Update status bar for current file
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    await statusBar.updateSyncStatus(editor.document.uri.fsPath);
  }

  // Hide progress
  statusBar.hidePrefetchProgress(totalUniqueFiles);
  logger.log('Prefetch complete');
  
  // Show summary notification (non-intrusive)
  showScanSummary(totalUniqueFiles, localChanges, orgNewer);
}

/**
 * Show a summary notification after scan completes
 * @param {number} totalFiles 
 * @param {string[]} localChanges 
 * @param {string[]} orgNewer 
 */
async function showScanSummary(totalFiles, localChanges, orgNewer) {
  const config = vscode.workspace.getConfiguration('sfMetadataTracker');
  if (!config.get('showScanSummary', true)) {
    return;
  }

  const localCount = localChanges.length;
  const orgCount = orgNewer.length;
  const totalChanges = localCount + orgCount;

  // Build message
  let message;
  if (totalChanges === 0) {
    message = `$(check) SF Metadata: ${totalFiles} files scanned, all in sync`;
  } else {
    const parts = [];
    if (localCount > 0) {
      parts.push(`${localCount} local change${localCount > 1 ? 's' : ''}`);
    }
    if (orgCount > 0) {
      parts.push(`${orgCount} org update${orgCount > 1 ? 's' : ''}`);
    }
    message = `$(cloud) SF Metadata: ${parts.join(', ')}`;
  }

  // Use status bar message for brief non-intrusive notification
  // It auto-dismisses after 5 seconds
  vscode.window.setStatusBarMessage(message, 5000);
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
 * @param {boolean} recompare - Whether to re-compare files with org
 */
export async function refreshAll(recompare = true) {
  if (decorationProvider) {
    // Clear all caches - both metadata info and diff results
    sourceTracking.clearSourceCache();
    decorationProvider._decorationCache.clear();
    decorationProvider._onDidChangeFileDecorations.fire(undefined);
    
    // Trigger a full re-prefetch if requested
    if (recompare) {
      await prefetchAllSalesforceFiles();
    }
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
