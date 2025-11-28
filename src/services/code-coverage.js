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
 * Run tests for the current Apex test class
 * Shows progress, results, coverage, and any errors
 * @returns {Promise<void>}
 */
export async function runCurrentTestClass() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('No file is currently open.');
    return;
  }

  const filePath = editor.document.uri.fsPath;
  
  if (!isApexFile(filePath)) {
    vscode.window.showWarningMessage('This command only works with Apex classes and triggers.');
    return;
  }

  const apexName = getApexName(filePath);
  if (!apexName) {
    vscode.window.showWarningMessage('Could not determine the Apex class name.');
    return;
  }

  // Check if it's a test class
  if (!isTestClass(apexName, filePath)) {
    // Not a test class - offer to find and run tests for this class
    const action = await vscode.window.showQuickPick([
      { label: '$(search) Find Tests for This Class', description: 'Search for test classes that cover this class', value: 'find' },
      { label: '$(play) Run All Tests', description: 'Run all tests in the org (slow)', value: 'all' },
    ], {
      placeHolder: `${apexName} is not a test class. What would you like to do?`,
    });

    if (action?.value === 'find') {
      // Try to find test classes that might test this class
      await findAndRunTestsForClass(apexName);
    } else if (action?.value === 'all') {
      vscode.window.showWarningMessage('Running all tests can take a long time. Use "sf apex run test" in terminal for more control.');
    }
    return;
  }

  // Save the file first
  await editor.document.save();

  // Run the test class
  await runTestClass(apexName);
}

/**
 * Find and run tests for a non-test class
 * @param {string} className 
 */
async function findAndRunTestsForClass(className) {
  // Common naming patterns for test classes
  const possibleTestNames = [
    `${className}Test`,
    `${className}_Test`,
    `Test${className}`,
    `${className}Tests`,
  ];

  // Show a quick pick to select or enter test class name
  const options = possibleTestNames.map(name => ({
    label: `$(beaker) ${name}`,
    description: 'Run this test class',
    value: name,
  }));
  
  options.push({
    label: '$(edit) Enter Test Class Name',
    description: 'Manually enter the test class name',
    value: '__custom__',
  });

  const selected = await vscode.window.showQuickPick(options, {
    placeHolder: `Select a test class to run for ${className}`,
  });

  if (!selected) return;

  let testClassName = selected.value;
  
  if (testClassName === '__custom__') {
    testClassName = await vscode.window.showInputBox({
      prompt: 'Enter the test class name',
      placeHolder: 'e.g., MyClassTest',
    });
    if (!testClassName) return;
  }

  await runTestClass(testClassName);
}

/**
 * Run a specific test class and show results
 * @param {string} testClassName 
 */
async function runTestClass(testClassName) {
  // Create output channel for test results
  const outputChannel = vscode.window.createOutputChannel('SF Apex Tests', 'log');
  outputChannel.show(true);
  outputChannel.clear();
  
  outputChannel.appendLine(`════════════════════════════════════════════════════════════════`);
  outputChannel.appendLine(`  Running Apex Tests: ${testClassName}`);
  outputChannel.appendLine(`  Started: ${new Date().toLocaleString()}`);
  outputChannel.appendLine(`════════════════════════════════════════════════════════════════`);
  outputChannel.appendLine('');
  outputChannel.appendLine('⏳ Submitting test run to Salesforce org...');
  outputChannel.appendLine('   This may take a few minutes depending on test complexity.');
  outputChannel.appendLine('');

  // Show progress notification
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Running tests: ${testClassName}`,
    cancellable: false,
  }, async (progress) => {
    progress.report({ message: 'Submitting test run...' });
    
    try {
      // Run the test with JSON output for parsing
      const result = await shell.execCommandWithTimeout(
        `sf apex run test --class-names ${testClassName} --code-coverage --result-format json --wait 10`,
        600000 // 10 minute timeout
      );
      
      const testResult = JSON.parse(result);
      
      progress.report({ message: 'Processing results...' });
      
      // Display results
      displayTestResults(outputChannel, testResult, testClassName);
      
      // Clear coverage cache to get fresh data
      clearCache();
      
      // Refresh coverage display for current file
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        await updateCoverageDisplay(editor);
      }
      
    } catch (error) {
      outputChannel.appendLine('');
      outputChannel.appendLine(`❌ ERROR: ${error.message}`);
      outputChannel.appendLine('');
      
      // Try to parse error output if it's JSON
      try {
        const errorData = JSON.parse(error.message);
        if (errorData.result) {
          displayTestResults(outputChannel, errorData, testClassName);
        }
      } catch {
        // Not JSON, show raw error
        outputChannel.appendLine('Check that the test class exists and compiles successfully.');
      }
      
      vscode.window.showErrorMessage(`Test run failed: ${error.message.substring(0, 100)}...`);
    }
  });
}

/**
 * Display test results in the output channel
 * @param {vscode.OutputChannel} outputChannel 
 * @param {Object} testResult 
 * @param {string} testClassName 
 */
function displayTestResults(outputChannel, testResult, testClassName) {
  const summary = testResult.result?.summary || testResult.summary || {};
  const tests = testResult.result?.tests || testResult.tests || [];
  const coverageRecords = testResult.result?.coverage?.records || testResult.coverage?.records || [];
  const coverageSummary = testResult.result?.coverage?.summary || testResult.coverage?.summary || {};
  
  // Summary section
  outputChannel.appendLine('📊 TEST SUMMARY');
  outputChannel.appendLine('────────────────────────────────────────────────────────────────');
  outputChannel.appendLine(`  Outcome:     ${summary.outcome || 'Unknown'}`);
  outputChannel.appendLine(`  Tests Run:   ${summary.testsRan || tests.length || 0}`);
  outputChannel.appendLine(`  Passing:     ${summary.passing || 0}`);
  outputChannel.appendLine(`  Failing:     ${summary.failing || 0}`);
  outputChannel.appendLine(`  Skipped:     ${summary.skipped || 0}`);
  outputChannel.appendLine(`  Duration:    ${summary.testRunTime || summary.testTotalTime || 'N/A'}`);
  outputChannel.appendLine('');

  // Individual test results
  if (tests.length > 0) {
    outputChannel.appendLine('📝 TEST METHODS');
    outputChannel.appendLine('────────────────────────────────────────────────────────────────');
    
    tests.forEach(test => {
      const status = test.Outcome || test.outcome;
      const icon = status === 'Pass' ? '✅' : status === 'Fail' ? '❌' : '⏭️';
      const methodName = test.MethodName || test.methodName || 'Unknown';
      const duration = test.RunTime || test.runTime || 0;
      
      outputChannel.appendLine(`  ${icon} ${methodName} (${duration}ms)`);
      
      // Show error details for failed tests
      if (status === 'Fail') {
        const message = test.Message || test.message || '';
        const stackTrace = test.StackTrace || test.stackTrace || '';
        
        if (message) {
          outputChannel.appendLine(`     ├─ Message: ${message}`);
        }
        if (stackTrace) {
          outputChannel.appendLine(`     └─ Stack Trace:`);
          stackTrace.split('\n').forEach(line => {
            outputChannel.appendLine(`        ${line}`);
          });
        }
        outputChannel.appendLine('');
      }
    });
    outputChannel.appendLine('');
  }

  // Coverage section - aggregate by class/trigger name
  if (coverageRecords.length > 0) {
    outputChannel.appendLine('🧪 CODE COVERAGE');
    outputChannel.appendLine('────────────────────────────────────────────────────────────────');
    
    // Aggregate coverage by class/trigger (multiple records per class from different test methods)
    const coverageByClass = new Map();
    coverageRecords.forEach(record => {
      const name = record.ApexClassOrTrigger?.Name || 'Unknown';
      const covered = record.NumLinesCovered || 0;
      const uncovered = record.NumLinesUncovered || 0;
      
      if (!coverageByClass.has(name)) {
        coverageByClass.set(name, { covered: 0, uncovered: 0, total: 0 });
      }
      
      // Use the max covered lines seen (coverage accumulates across test methods)
      const existing = coverageByClass.get(name);
      if (covered > existing.covered) {
        existing.covered = covered;
      }
      if (uncovered > existing.uncovered || existing.uncovered === 0) {
        existing.uncovered = uncovered;
      }
    });
    
    // Convert to array and calculate percentages
    const aggregatedCoverage = Array.from(coverageByClass.entries()).map(([name, data]) => {
      const total = data.covered + data.uncovered;
      const percent = total > 0 ? Math.round((data.covered / total) * 100) : 0;
      return { name, covered: data.covered, uncovered: data.uncovered, total, percent };
    });
    
    // Sort by coverage percentage (ascending, so lowest coverage is first)
    aggregatedCoverage.sort((a, b) => a.percent - b.percent);
    
    aggregatedCoverage.forEach(cov => {
      let icon = '🔴';
      if (cov.percent >= 75) icon = '🟢';
      else if (cov.percent >= 50) icon = '🟡';
      
      outputChannel.appendLine(`  ${icon} ${cov.name}: ${cov.percent}% (${cov.covered}/${cov.total} lines)`);
    });
    outputChannel.appendLine('');
    
    // Overall coverage from summary
    const orgCoverage = coverageSummary.orgWideCoverage || summary.orgWideCoverage;
    const testCoverage = coverageSummary.testRunCoverage || summary.testRunCoverage;
    if (testCoverage) {
      outputChannel.appendLine(`  📊 Test Run Coverage: ${testCoverage}`);
    }
    if (orgCoverage) {
      outputChannel.appendLine(`  📈 Org-wide Coverage: ${orgCoverage}`);
    }
    if (testCoverage || orgCoverage) {
      outputChannel.appendLine('');
    }
  }

  // Final status
  outputChannel.appendLine('════════════════════════════════════════════════════════════════');
  const outcome = summary.outcome || 'Unknown';
  if (outcome === 'Passed') {
    outputChannel.appendLine('  ✅ ALL TESTS PASSED');
    vscode.window.showInformationMessage(`✅ All tests passed in ${testClassName}`);
  } else if (summary.failing > 0) {
    outputChannel.appendLine(`  ❌ ${summary.failing} TEST(S) FAILED`);
    vscode.window.showErrorMessage(`❌ ${summary.failing} test(s) failed in ${testClassName}. See output for details.`);
  } else {
    outputChannel.appendLine(`  ⚠️ Test run completed with status: ${outcome}`);
  }
  outputChannel.appendLine(`  Finished: ${new Date().toLocaleString()}`);
  outputChannel.appendLine('════════════════════════════════════════════════════════════════');
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
