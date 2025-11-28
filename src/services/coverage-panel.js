import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as shell from '../lib/shell.js';
import * as logger from '../lib/logger.js';
import * as sourceTracking from './source-tracking.js';
import * as codeCoverage from './code-coverage.js';

/**
 * Code Coverage Panel Service
 * Provides a tree view showing code coverage for all Apex classes and triggers
 */

// Tree data provider instance
let treeDataProvider = null;
let treeView = null;

// Coverage data cache
const coverageData = new Map();
let isLoading = false;
let lastRefresh = null;

/**
 * Tree item for code coverage
 */
class CoverageTreeItem extends vscode.TreeItem {
  constructor(label, collapsibleState, coverage, filePath, contextValue) {
    super(label, collapsibleState);
    this.coverage = coverage;
    this.filePath = filePath;
    this.contextValue = contextValue || 'coverageItem';
    
    if (coverage !== undefined && coverage !== null) {
      this.setupCoverageDisplay();
    }
  }

  setupCoverageDisplay() {
    const percentage = this.coverage.percentage;
    
    // Set icon based on coverage level
    if (percentage >= 75) {
      this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
    } else if (percentage >= 50) {
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    } else {
      this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    }
    
    // Set description with coverage percentage
    this.description = `${percentage}% (${this.coverage.covered}/${this.coverage.covered + this.coverage.uncovered})`;
    
    // Set tooltip with details
    const status = percentage >= 75 ? '✅ Meets 75% requirement' : 
                   percentage >= 50 ? '⚠️ Below 75% requirement' : 
                   '❌ Critical: Below 50%';
    this.tooltip = new vscode.MarkdownString(
      `**${this.label}**\n\n` +
      `Coverage: **${percentage}%**\n\n` +
      `- Lines Covered: ${this.coverage.covered}\n` +
      `- Lines Uncovered: ${this.coverage.uncovered}\n` +
      `- Total Lines: ${this.coverage.covered + this.coverage.uncovered}\n\n` +
      `${status}`
    );
    
    // Make item clickable to open the file and show coverage
    if (this.filePath) {
      this.command = {
        command: 'sf-metadata-tracker.openWithCoverage',
        title: 'Open File with Coverage',
        arguments: [this.filePath],
      };
    }
  }
}

/**
 * Tree item for category headers (Classes, Triggers)
 */
class CategoryTreeItem extends vscode.TreeItem {
  constructor(label, itemCount, avgCoverage, contextValue) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = contextValue || 'category';
    this.itemCount = itemCount;
    this.avgCoverage = avgCoverage;
    
    if (itemCount > 0) {
      this.description = `${itemCount} items • Avg: ${avgCoverage}%`;
    } else {
      this.description = 'No items';
    }
  }
}

/**
 * Tree item for summary/stats
 */
class SummaryTreeItem extends vscode.TreeItem {
  constructor(label, value, icon) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'summary';
  }
}

/**
 * Tree data provider for code coverage
 */
class CoverageTreeDataProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    if (!element) {
      // Root level - show summary and categories
      return this.getRootItems();
    }
    
    if (element.contextValue === 'category') {
      return this.getCategoryItems(element.label);
    }
    
    return [];
  }

  async getRootItems() {
    const items = [];
    
    // Check org connection
    const orgStatus = sourceTracking.getCachedOrgConnection();
    if (!orgStatus.connected) {
      items.push(new CoverageTreeItem(
        'Not connected to org',
        vscode.TreeItemCollapsibleState.None,
        null,
        null,
        'info'
      ));
      items[0].iconPath = new vscode.ThemeIcon('warning');
      items[0].description = 'Connect to an org to view coverage';
      return items;
    }
    
    if (isLoading) {
      items.push(new CoverageTreeItem(
        'Loading coverage data...',
        vscode.TreeItemCollapsibleState.None,
        null,
        null,
        'loading'
      ));
      items[0].iconPath = new vscode.ThemeIcon('sync~spin');
      return items;
    }
    
    if (coverageData.size === 0) {
      items.push(new CoverageTreeItem(
        'No coverage data',
        vscode.TreeItemCollapsibleState.None,
        null,
        null,
        'info'
      ));
      items[0].iconPath = new vscode.ThemeIcon('info');
      items[0].description = 'Click refresh to load coverage';
      return items;
    }
    
    // Calculate summary stats
    const classes = [];
    const triggers = [];
    
    coverageData.forEach((data) => {
      if (data.type === 'ApexClass') {
        classes.push(data);
      } else if (data.type === 'ApexTrigger') {
        triggers.push(data);
      }
    });
    
    // Sort by coverage (lowest first)
    classes.sort((a, b) => a.percentage - b.percentage);
    triggers.sort((a, b) => a.percentage - b.percentage);
    
    // Calculate org-wide coverage
    const allItems = [...classes, ...triggers];
    const totalCovered = allItems.reduce((sum, item) => sum + item.covered, 0);
    const totalUncovered = allItems.reduce((sum, item) => sum + item.uncovered, 0);
    const totalLines = totalCovered + totalUncovered;
    const orgCoverage = totalLines > 0 ? Math.round((totalCovered / totalLines) * 100) : 0;
    
    // Count items by coverage level
    const critical = allItems.filter(i => i.percentage < 50).length;
    const warning = allItems.filter(i => i.percentage >= 50 && i.percentage < 75).length;
    const good = allItems.filter(i => i.percentage >= 75).length;
    
    // Add summary section
    const summaryIcon = orgCoverage >= 75 ? 'check' : orgCoverage >= 50 ? 'warning' : 'error';
    items.push(new SummaryTreeItem('Org Coverage', `${orgCoverage}%`, summaryIcon));
    items.push(new SummaryTreeItem('Total Classes', `${allItems.length}`, 'file-code'));
    
    if (critical > 0) {
      items.push(new SummaryTreeItem('Critical (<50%)', `${critical}`, 'error'));
    }
    if (warning > 0) {
      items.push(new SummaryTreeItem('Warning (50-74%)', `${warning}`, 'warning'));
    }
    if (good > 0) {
      items.push(new SummaryTreeItem('Good (≥75%)', `${good}`, 'check'));
    }
    
    // Add separator
    const separator = new vscode.TreeItem('', vscode.TreeItemCollapsibleState.None);
    separator.description = '────────────────────';
    items.push(separator);
    
    // Add categories
    if (classes.length > 0) {
      const avgClassCoverage = Math.round(
        classes.reduce((sum, c) => sum + c.percentage, 0) / classes.length
      );
      items.push(new CategoryTreeItem('Apex Classes', classes.length, avgClassCoverage, 'category'));
    }
    
    if (triggers.length > 0) {
      const avgTriggerCoverage = Math.round(
        triggers.reduce((sum, t) => sum + t.percentage, 0) / triggers.length
      );
      items.push(new CategoryTreeItem('Apex Triggers', triggers.length, avgTriggerCoverage, 'category'));
    }
    
    // Add last refresh time
    if (lastRefresh) {
      const timeAgo = getTimeAgo(lastRefresh);
      const refreshInfo = new vscode.TreeItem('', vscode.TreeItemCollapsibleState.None);
      refreshInfo.description = `Last updated: ${timeAgo}`;
      refreshInfo.iconPath = new vscode.ThemeIcon('clock');
      items.push(refreshInfo);
    }
    
    return items;
  }

  getCategoryItems(category) {
    const items = [];
    
    coverageData.forEach((data) => {
      const matchesClass = category === 'Apex Classes' && data.type === 'ApexClass';
      const matchesTrigger = category === 'Apex Triggers' && data.type === 'ApexTrigger';
      
      if (matchesClass || matchesTrigger) {
        const item = new CoverageTreeItem(
          data.name,
          vscode.TreeItemCollapsibleState.None,
          {
            percentage: data.percentage,
            covered: data.covered,
            uncovered: data.uncovered,
          },
          data.filePath,
          'coverageItem'
        );
        items.push(item);
      }
    });
    
    // Sort by coverage (lowest first to highlight problem areas)
    items.sort((a, b) => (a.coverage?.percentage || 0) - (b.coverage?.percentage || 0));
    
    return items;
  }
}

/**
 * Get human-readable time ago string
 */
function getTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Find all Apex files in the workspace
 */
async function findApexFiles() {
  const classFiles = await vscode.workspace.findFiles('**/classes/*.cls', '**/node_modules/**');
  const triggerFiles = await vscode.workspace.findFiles('**/triggers/*.trigger', '**/node_modules/**');
  
  const files = [];
  
  for (const file of classFiles) {
    const name = path.basename(file.fsPath, '.cls');
    // Skip test classes
    if (!isTestClass(name, file.fsPath)) {
      files.push({ name, path: file.fsPath, type: 'ApexClass' });
    }
  }
  
  for (const file of triggerFiles) {
    const name = path.basename(file.fsPath, '.trigger');
    files.push({ name, path: file.fsPath, type: 'ApexTrigger' });
  }
  
  return files;
}

/**
 * Check if class is a test class
 */
function isTestClass(name, filePath) {
  // Check name patterns
  const testPatterns = [/Test$/i, /Tests$/i, /_Test$/i, /^Test/i];
  if (testPatterns.some(pattern => pattern.test(name))) {
    return true;
  }
  
  // Check for @isTest annotation
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return /@isTest/i.test(content);
  } catch {
    return false;
  }
}

/**
 * Fetch coverage for all classes from org
 */
async function fetchAllCoverage() {
  const orgStatus = sourceTracking.getCachedOrgConnection();
  if (!orgStatus.connected) {
    logger.log('Cannot fetch coverage: not connected to org');
    return;
  }

  isLoading = true;
  treeDataProvider?.refresh();
  
  try {
    // Query all aggregate coverage data at once
    const query = `SELECT ApexClassOrTrigger.Name, ApexClassOrTriggerId, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate`;
    
    const result = await shell.execCommandWithTimeout(
      `sf data query --query "${query}" --use-tooling-api --json`,
      60000
    );
    
    const data = JSON.parse(result);
    
    if (data.status !== 0 || !data.result?.records) {
      logger.log('Failed to fetch coverage data');
      isLoading = false;
      treeDataProvider?.refresh();
      return;
    }
    
    // Find local files to match
    const localFiles = await findApexFiles();
    const localFileMap = new Map();
    localFiles.forEach(f => localFileMap.set(f.name.toLowerCase(), f));
    
    // Process coverage records
    coverageData.clear();
    
    for (const record of data.result.records) {
      const name = record.ApexClassOrTrigger?.Name;
      if (!name) continue;
      
      const covered = record.NumLinesCovered || 0;
      const uncovered = record.NumLinesUncovered || 0;
      const total = covered + uncovered;
      const percentage = total > 0 ? Math.round((covered / total) * 100) : 0;
      
      // Match with local file
      const localFile = localFileMap.get(name.toLowerCase());
      
      coverageData.set(name, {
        name,
        type: localFile?.type || 'ApexClass',
        filePath: localFile?.path || null,
        covered,
        uncovered,
        percentage,
      });
    }
    
    lastRefresh = new Date();
    logger.log(`Loaded coverage for ${coverageData.size} classes/triggers`);
    
  } catch (error) {
    logger.log(`Failed to fetch all coverage: ${error.message}`, 'WARN');
  } finally {
    isLoading = false;
    treeDataProvider?.refresh();
  }
}

/**
 * Initialize the coverage panel
 * @param {vscode.ExtensionContext} context 
 */
export function initialize(context) {
  // Create tree data provider
  treeDataProvider = new CoverageTreeDataProvider();
  
  // Create tree view
  treeView = vscode.window.createTreeView('sfCoveragePanel', {
    treeDataProvider,
    showCollapseAll: true,
  });
  
  context.subscriptions.push(treeView);
  
  // Register refresh command
  context.subscriptions.push(
    vscode.commands.registerCommand('sf-metadata-tracker.refreshCoveragePanel', async () => {
      await fetchAllCoverage();
    })
  );
  
  // Register open with coverage command
  context.subscriptions.push(
    vscode.commands.registerCommand('sf-metadata-tracker.openWithCoverage', async (filePath) => {
      if (!filePath) return;
      
      // Open the file
      const document = await vscode.workspace.openTextDocument(filePath);
      const editor = await vscode.window.showTextDocument(document);
      
      // Enable coverage highlighting and show it
      await codeCoverage.showCoverageForFile(editor);
    })
  );
  
  // Register export coverage command
  context.subscriptions.push(
    vscode.commands.registerCommand('sf-metadata-tracker.exportCoverage', async () => {
      await exportCoverage();
    })
  );
  
  // Auto-load coverage data after a short delay (allow org connection to establish)
  setTimeout(async () => {
    await fetchAllCoverage();
  }, 6000);
  
  logger.log('Coverage panel initialized');
}

/**
 * Refresh the coverage panel
 */
export async function refresh() {
  await fetchAllCoverage();
}

/**
 * Export coverage data to CSV file
 */
export async function exportCoverage() {
  if (coverageData.size === 0) {
    vscode.window.showWarningMessage('No coverage data to export. Please refresh the coverage panel first.');
    return;
  }

  // Ask user for export format
  const format = await vscode.window.showQuickPick([
    { label: '$(file) CSV', description: 'Comma-separated values file', value: 'csv' },
    { label: '$(json) JSON', description: 'JSON format', value: 'json' },
  ], {
    placeHolder: 'Select export format',
  });

  if (!format) return;

  // Prepare data
  const classes = [];
  const triggers = [];
  
  coverageData.forEach((data) => {
    if (data.type === 'ApexClass') {
      classes.push(data);
    } else if (data.type === 'ApexTrigger') {
      triggers.push(data);
    }
  });

  const allItems = [...classes, ...triggers];
  allItems.sort((a, b) => a.name.localeCompare(b.name));

  // Calculate summary
  const totalCovered = allItems.reduce((sum, item) => sum + item.covered, 0);
  const totalUncovered = allItems.reduce((sum, item) => sum + item.uncovered, 0);
  const totalLines = totalCovered + totalUncovered;
  const orgCoverage = totalLines > 0 ? Math.round((totalCovered / totalLines) * 100) : 0;

  let content = '';
  let defaultFileName = '';
  const timestamp = new Date().toISOString().split('T')[0];

  if (format.value === 'csv') {
    // Generate CSV content
    const lines = [
      'Name,Type,Coverage %,Lines Covered,Lines Uncovered,Total Lines,Status',
    ];

    for (const item of allItems) {
      const status = item.percentage >= 75 ? 'Good' : item.percentage >= 50 ? 'Warning' : 'Critical';
      const total = item.covered + item.uncovered;
      lines.push(`"${item.name}","${item.type}",${item.percentage},${item.covered},${item.uncovered},${total},"${status}"`);
    }

    // Add summary rows
    lines.push('');
    lines.push(`"TOTAL","",${orgCoverage},${totalCovered},${totalUncovered},${totalLines},""`);
    lines.push(`"Classes Count","",${classes.length},,,,`);
    lines.push(`"Triggers Count","",${triggers.length},,,,`);
    lines.push(`"Export Date","","${new Date().toLocaleString()}",,,,`);

    content = lines.join('\n');
    defaultFileName = `code-coverage-${timestamp}.csv`;
  } else {
    // Generate JSON content
    const jsonData = {
      exportDate: new Date().toISOString(),
      summary: {
        orgCoverage: orgCoverage,
        totalCovered: totalCovered,
        totalUncovered: totalUncovered,
        totalLines: totalLines,
        classesCount: classes.length,
        triggersCount: triggers.length,
        criticalCount: allItems.filter(i => i.percentage < 50).length,
        warningCount: allItems.filter(i => i.percentage >= 50 && i.percentage < 75).length,
        goodCount: allItems.filter(i => i.percentage >= 75).length,
      },
      coverage: allItems.map(item => ({
        name: item.name,
        type: item.type,
        percentage: item.percentage,
        linesCovered: item.covered,
        linesUncovered: item.uncovered,
        totalLines: item.covered + item.uncovered,
        status: item.percentage >= 75 ? 'Good' : item.percentage >= 50 ? 'Warning' : 'Critical',
      })),
    };

    content = JSON.stringify(jsonData, null, 2);
    defaultFileName = `code-coverage-${timestamp}.json`;
  }

  // Ask where to save
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
      defaultFileName
    )),
    filters: format.value === 'csv' 
      ? { 'CSV Files': ['csv'], 'All Files': ['*'] }
      : { 'JSON Files': ['json'], 'All Files': ['*'] },
    title: 'Export Code Coverage',
  });

  if (!uri) return;

  try {
    fs.writeFileSync(uri.fsPath, content, 'utf8');
    
    const openFile = await vscode.window.showInformationMessage(
      `Coverage data exported to ${path.basename(uri.fsPath)}`,
      'Open File',
      'Open Folder'
    );

    if (openFile === 'Open File') {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
    } else if (openFile === 'Open Folder') {
      await vscode.commands.executeCommand('revealFileInOS', uri);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to export coverage: ${error.message}`);
  }
}

/**
 * Dispose the coverage panel
 */
export function dispose() {
  coverageData.clear();
  treeView?.dispose();
}
