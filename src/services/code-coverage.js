import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as shell from '../lib/shell.js';
import * as logger from '../lib/logger.js';
import * as sourceTracking from './source-tracking.js';

/**
 * Code Coverage Service
 * Fetches and displays Apex code coverage using Salesforce Tooling API
 */

// Cache for coverage data
const coverageCache = new Map();

// Editor decorations for line coverage
let coveredLineDecoration = null;
let uncoveredLineDecoration = null;

// Status bar item for coverage percentage
let coverageStatusBarItem = null;

// Track if coverage is currently shown
let coverageVisible = false;

// Track active decorations by editor
const activeDecorations = new Map();

/**
 * Initialize the code coverage service
 * @param {vscode.ExtensionContext} context 
 */
export function initialize(context) {
  // Create decoration types for covered/uncovered lines
  coveredLineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    gutterIconPath: context.asAbsolutePath('assets/covered.svg'),
    gutterIconSize: 'contain',
  });

  uncoveredLineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    gutterIconPath: context.asAbsolutePath('assets/uncovered.svg'),
    gutterIconSize: 'contain',
  });

  // Create status bar item for coverage
  coverageStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100 // High priority to show on the left
  );
  coverageStatusBarItem.command = 'sf-metadata-tracker.toggleCoverage';
  coverageStatusBarItem.name = 'SF Code Coverage';
  context.subscriptions.push(coverageStatusBarItem);

  // Watch for active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        updateCoverageDisplay(editor);
      }
    })
  );

  // Delay initial coverage fetch to allow org connection to establish
  // The org connection check runs async during extension activation
  setTimeout(() => {
    if (vscode.window.activeTextEditor) {
      updateCoverageDisplay(vscode.window.activeTextEditor);
    }
  }, 5000);

  logger.log('Code coverage service initialized');
}

/**
 * Check if file is an Apex class or trigger
 * @param {string} filePath 
 * @returns {boolean}
 */
function isApexFile(filePath) {
  return filePath.endsWith('.cls') || filePath.endsWith('.trigger');
}

/**
 * Check if the Apex class is a test class by name pattern
 * @param {string} apexName 
 * @returns {boolean}
 */
function isTestClassByName(apexName) {
  // Common naming conventions for test classes
  const testPatterns = [
    /Test$/i,
    /Tests$/i,
    /_Test$/i,
    /^Test/i,
  ];
  return testPatterns.some(pattern => pattern.test(apexName));
}

/**
 * Check if the file contains @isTest annotation
 * @param {string} filePath 
 * @returns {boolean}
 */
function hasIsTestAnnotation(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    // Check for @isTest annotation (case insensitive)
    return /@isTest/i.test(content);
  } catch {
    return false;
  }
}

/**
 * Check if the Apex class is a test class (by name or @isTest annotation)
 * @param {string} apexName 
 * @param {string} filePath 
 * @returns {boolean}
 */
function isTestClass(apexName, filePath) {
  return isTestClassByName(apexName) || hasIsTestAnnotation(filePath);
}

/**
 * Get the Apex class/trigger name from file path
 * @param {string} filePath 
 * @returns {string|null}
 */
function getApexName(filePath) {
  const fileName = path.basename(filePath);
  if (fileName.endsWith('.cls')) {
    return fileName.replace('.cls', '');
  }
  if (fileName.endsWith('.trigger')) {
    return fileName.replace('.trigger', '');
  }
  return null;
}

/**
 * Fetch aggregate coverage for a class/trigger
 * Uses Tooling API via sf data query
 * @param {string} apexName 
 * @param {string} apexType - 'ApexClass' or 'ApexTrigger'
 * @returns {Promise<{covered: number, uncovered: number, percentage: number, coveredLines: number[], uncoveredLines: number[]}|null>}
 */
export async function getAggregateCoverage(apexName, apexType = 'ApexClass') {
  const cacheKey = `${apexType}:${apexName}`;
  
  // Check cache (valid for 5 minutes)
  const cached = coverageCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 300000) {
    return cached.data;
  }

  const orgStatus = sourceTracking.getCachedOrgConnection();
  if (!orgStatus.connected) {
    return null;
  }

  try {
    // First get the ApexClass/ApexTrigger ID
    const idQuery = `SELECT Id FROM ${apexType} WHERE Name = '${apexName}' LIMIT 1`;
    const idResult = await shell.execCommandWithTimeout(
      `sf data query --query "${idQuery}" --json`,
      15000
    );
    const idData = JSON.parse(idResult);
    
    if (idData.status !== 0 || !idData.result?.records?.length) {
      return null;
    }
    
    const apexId = idData.result.records[0].Id;

    // Query aggregate coverage from Tooling API
    const coverageQuery = `SELECT ApexClassOrTriggerId, NumLinesCovered, NumLinesUncovered, Coverage FROM ApexCodeCoverageAggregate WHERE ApexClassOrTriggerId = '${apexId}'`;
    
    const result = await shell.execCommandWithTimeout(
      `sf data query --query "${coverageQuery}" --use-tooling-api --json`,
      15000
    );
    const data = JSON.parse(result);

    if (data.status !== 0 || !data.result?.records?.length) {
      // No coverage data - might not have run tests yet
      const noCoverageData = { covered: 0, uncovered: 0, percentage: 0, coveredLines: [], uncoveredLines: [], noData: true };
      coverageCache.set(cacheKey, { timestamp: Date.now(), data: noCoverageData });
      return noCoverageData;
    }

    const record = data.result.records[0];
    const covered = record.NumLinesCovered || 0;
    const uncovered = record.NumLinesUncovered || 0;
    const total = covered + uncovered;
    const percentage = total > 0 ? Math.round((covered / total) * 100) : 0;
    
    // Extract line numbers from Coverage field
    const coveredLines = record.Coverage?.coveredLines || [];
    const uncoveredLines = record.Coverage?.uncoveredLines || [];

    const coverageData = {
      covered,
      uncovered,
      percentage,
      coveredLines,
      uncoveredLines,
      noData: false,
    };

    // Cache the result
    coverageCache.set(cacheKey, { timestamp: Date.now(), data: coverageData });
    
    return coverageData;
  } catch (error) {
    logger.log(`Failed to fetch coverage for ${apexName}: ${error.message}`, 'WARN');
    return null;
  }
}

/**
 * Update coverage display for the active editor
 * @param {vscode.TextEditor} editor 
 */
export async function updateCoverageDisplay(editor) {
  if (!editor) return;

  const filePath = editor.document.uri.fsPath;
  
  // Only show for Apex files
  if (!isApexFile(filePath)) {
    coverageStatusBarItem?.hide();
    clearEditorDecorations(editor);
    return;
  }

  const config = vscode.workspace.getConfiguration('sfMetadataTracker');
  if (!config.get('showCoverageStatus', true)) {
    coverageStatusBarItem?.hide();
    return;
  }

  const apexName = getApexName(filePath);
  if (!apexName) {
    coverageStatusBarItem?.hide();
    return;
  }

  // Test classes don't have coverage data for themselves
  if (isTestClass(apexName, filePath)) {
    coverageStatusBarItem.text = '$(beaker) Test Class';
    coverageStatusBarItem.tooltip = 'This is a test class - coverage shows for the classes it tests';
    coverageStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    coverageStatusBarItem.color = undefined;
    coverageStatusBarItem.show();
    return;
  }

  // Determine type
  const apexType = filePath.endsWith('.trigger') ? 'ApexTrigger' : 'ApexClass';
  
  // Show loading state
  coverageStatusBarItem.text = '$(sync~spin) Loading...';
  coverageStatusBarItem.tooltip = 'Fetching code coverage data...';
  coverageStatusBarItem.backgroundColor = undefined;
  coverageStatusBarItem.color = new vscode.ThemeColor('charts.blue');
  coverageStatusBarItem.show();
  
  logger.log(`Fetching coverage for ${apexName} (${apexType})...`);
  
  // Fetch coverage
  const coverage = await getAggregateCoverage(apexName, apexType);
  
  if (!coverage) {
    logger.log(`No coverage returned for ${apexName}`);
    coverageStatusBarItem.text = '$(beaker) --';
    coverageStatusBarItem.tooltip = 'Unable to fetch coverage data';
    coverageStatusBarItem.backgroundColor = undefined;
    coverageStatusBarItem.show();
    return;
  }

  if (coverage.noData) {
    logger.log(`No coverage data for ${apexName} (tests not run)`);
    coverageStatusBarItem.text = '$(beaker) N/A';
    coverageStatusBarItem.tooltip = 'No coverage data available. Run tests to generate coverage.';
    coverageStatusBarItem.backgroundColor = undefined;
    coverageStatusBarItem.show();
    return;
  }

  logger.log(`Coverage for ${apexName}: ${coverage.percentage}% (${coverage.covered}/${coverage.covered + coverage.uncovered} lines)`);

  // Update status bar
  if (!coverageStatusBarItem) {
    logger.log('Coverage status bar item not initialized!', 'WARN');
    return;
  }
  
  // Color coding based on coverage thresholds:
  // >= 75%: Green (good) - meets Salesforce deployment requirement
  // 50-74%: Yellow (warning) - needs improvement  
  // < 50%: Red (critical) - below acceptable threshold
  let icon, statusText, bgColor;
  
  if (coverage.percentage >= 75) {
    icon = '$(check)';
    statusText = `${coverage.percentage}%`;
    bgColor = undefined; // Default (or could use a green theme color)
    coverageStatusBarItem.color = new vscode.ThemeColor('testing.iconPassed');
  } else if (coverage.percentage >= 50) {
    icon = '$(warning)';
    statusText = `${coverage.percentage}%`;
    bgColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    coverageStatusBarItem.color = undefined;
  } else {
    icon = '$(error)';
    statusText = `${coverage.percentage}%`;
    bgColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    coverageStatusBarItem.color = undefined;
  }
  
  coverageStatusBarItem.text = `${icon} ${statusText}`;
  coverageStatusBarItem.tooltip = `Code Coverage: ${coverage.percentage}%\n${coverage.covered} lines covered, ${coverage.uncovered} uncovered\n\n${coverage.percentage >= 75 ? '✅ Meets 75% deployment requirement' : coverage.percentage >= 50 ? '⚠️ Below 75% deployment requirement' : '❌ Critical: Below 50% coverage'}\n\nClick to toggle line highlighting`;
  coverageStatusBarItem.backgroundColor = bgColor;
  
  coverageStatusBarItem.show();
  logger.log(`Status bar updated: ${coverageStatusBarItem.text}`);

  // Apply line decorations if coverage view is enabled
  if (coverageVisible) {
    applyLineDecorations(editor, coverage);
  }
}

/**
 * Apply line decorations to show covered/uncovered lines
 * @param {vscode.TextEditor} editor 
 * @param {Object} coverage 
 */
function applyLineDecorations(editor, coverage) {
  if (!coverage || !coveredLineDecoration || !uncoveredLineDecoration) return;

  const coveredRanges = coverage.coveredLines.map(line => {
    const lineIndex = line - 1; // Convert to 0-based
    return new vscode.Range(lineIndex, 0, lineIndex, 0);
  });

  const uncoveredRanges = coverage.uncoveredLines.map(line => {
    const lineIndex = line - 1; // Convert to 0-based
    return new vscode.Range(lineIndex, 0, lineIndex, 0);
  });

  editor.setDecorations(coveredLineDecoration, coveredRanges);
  editor.setDecorations(uncoveredLineDecoration, uncoveredRanges);
  
  // Track active decorations
  activeDecorations.set(editor.document.uri.fsPath, true);
}

/**
 * Clear line decorations from editor
 * @param {vscode.TextEditor} editor 
 */
function clearEditorDecorations(editor) {
  if (!editor || !coveredLineDecoration || !uncoveredLineDecoration) return;
  
  editor.setDecorations(coveredLineDecoration, []);
  editor.setDecorations(uncoveredLineDecoration, []);
  activeDecorations.delete(editor.document.uri.fsPath);
}

/**
 * Toggle coverage line highlighting
 */
export async function toggleCoverage() {
  coverageVisible = !coverageVisible;
  
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  if (coverageVisible) {
    // Show coverage
    const filePath = editor.document.uri.fsPath;
    if (isApexFile(filePath)) {
      const apexName = getApexName(filePath);
      const apexType = filePath.endsWith('.trigger') ? 'ApexTrigger' : 'ApexClass';
      
      // Show loading state
      vscode.window.setStatusBarMessage('$(sync~spin) Loading coverage...', 3000);
      
      const coverage = await getAggregateCoverage(apexName, apexType);
      if (coverage && !coverage.noData) {
        applyLineDecorations(editor, coverage);
        vscode.window.setStatusBarMessage('$(eye) Coverage highlighting enabled', 2000);
      } else {
        vscode.window.setStatusBarMessage('$(warning) No coverage data available', 2000);
      }
    }
  } else {
    // Hide coverage
    clearEditorDecorations(editor);
    vscode.window.setStatusBarMessage('$(eye-closed) Coverage highlighting disabled', 2000);
  }
}

/**
 * Refresh coverage for current file
 */
export async function refreshCoverage() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const filePath = editor.document.uri.fsPath;
  if (!isApexFile(filePath)) {
    vscode.window.showInformationMessage('Coverage is only available for Apex classes and triggers');
    return;
  }

  const apexName = getApexName(filePath);
  const apexType = filePath.endsWith('.trigger') ? 'ApexTrigger' : 'ApexClass';
  
  // Clear cache to force refresh
  coverageCache.delete(`${apexType}:${apexName}`);
  
  // Show loading state in status bar
  if (coverageStatusBarItem) {
    coverageStatusBarItem.text = '$(sync~spin) Refreshing...';
    coverageStatusBarItem.tooltip = 'Refreshing code coverage data from org...';
    coverageStatusBarItem.backgroundColor = undefined;
    coverageStatusBarItem.color = new vscode.ThemeColor('charts.blue');
    coverageStatusBarItem.show();
  }
  
  await updateCoverageDisplay(editor);
  vscode.window.setStatusBarMessage('$(check) Coverage refreshed', 2000);
}

/**
 * Clear coverage cache
 */
export function clearCache() {
  coverageCache.clear();
}

/**
 * Dispose resources
 */
export function dispose() {
  coverageCache.clear();
  coverageStatusBarItem?.dispose();
  coveredLineDecoration?.dispose();
  uncoveredLineDecoration?.dispose();
}
