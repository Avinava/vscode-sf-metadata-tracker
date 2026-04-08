import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as logger from './logger.js';

/**
 * Salesforce CLI detection and management
 */

// Cache for CLI status
let cliStatusCache = {
  installed: null,
  version: null,
  resolvedPath: null,
  lastChecked: null,
};

// Global-state key for suppressing the CLI prompt
const SUPPRESS_CLI_PROMPT_KEY = 'sfMetadataTracker.suppressCliPrompt';

/**
 * Common paths where `sf` may be installed but not on VS Code's PATH
 */
function getCandidatePaths() {
  const home = os.homedir();
  const candidates = [
    'sf',                                           // default PATH
    '/usr/local/bin/sf',                             // Homebrew / manual install
    path.join(home, '.local', 'bin', 'sf'),          // npm global (Linux)
    '/opt/homebrew/bin/sf',                          // Apple Silicon Homebrew
  ];

  // Add nvm-managed node versions
  const nvmDir = path.join(home, '.nvm', 'versions', 'node');
  try {
    if (fs.existsSync(nvmDir)) {
      const versions = fs.readdirSync(nvmDir);
      for (const v of versions) {
        candidates.push(path.join(nvmDir, v, 'bin', 'sf'));
      }
    }
  } catch {
    // ignore
  }

  return candidates;
}

/**
 * Check if Salesforce CLI is installed
 * Tries multiple common paths to work around VS Code PATH limitations.
 * @returns {Promise<{installed: boolean, version?: string, resolvedPath?: string, error?: string}>}
 */
export async function checkSfCliInstalled() {
  // Check cache (valid for 5 minutes)
  if (cliStatusCache.lastChecked && Date.now() - cliStatusCache.lastChecked < 300000) {
    return {
      installed: cliStatusCache.installed,
      version: cliStatusCache.version,
      resolvedPath: cliStatusCache.resolvedPath,
    };
  }

  const candidates = getCandidatePaths();

  for (const sfPath of candidates) {
    try {
      const version = await tryCliPath(sfPath);
      if (version) {
        cliStatusCache = {
          installed: true,
          version,
          resolvedPath: sfPath,
          lastChecked: Date.now(),
        };
        logger.log(`Salesforce CLI found at ${sfPath}: ${version}`);
        return { installed: true, version, resolvedPath: sfPath };
      }
    } catch {
      // try next candidate
    }
  }

  cliStatusCache = {
    installed: false,
    version: null,
    resolvedPath: null,
    lastChecked: Date.now(),
  };
  logger.log('Salesforce CLI not found on any known path', 'WARN');
  return { installed: false, error: 'Salesforce CLI (sf) is not installed' };
}

/**
 * Try running `<path> --version` and return the version string or null
 * @param {string} sfPath
 * @returns {Promise<string|null>}
 */
function tryCliPath(sfPath) {
  return new Promise((resolve) => {
    exec(`"${sfPath}" --version`, { timeout: 10000 }, (error, stdout) => {
      if (error) {
        resolve(null);
      } else {
        resolve(stdout.trim().split('\n')[0]);
      }
    });
  });
}

/**
 * Get the resolved CLI path (for use by shell commands)
 * @returns {string}
 */
export function getResolvedCliPath() {
  return cliStatusCache.resolvedPath || 'sf';
}

/**
 * Get cached CLI status
 * @returns {{installed: boolean | null, version: string | null}}
 */
export function getCachedCliStatus() {
  return {
    installed: cliStatusCache.installed,
    version: cliStatusCache.version,
  };
}

/**
 * Show a non-blocking warning to install Salesforce CLI.
 * Respects a "Don't show again" preference stored in globalState.
 * @param {vscode.Memento} globalState
 */
export async function promptInstallCli(globalState) {
  // Honour the suppress flag
  if (globalState?.get(SUPPRESS_CLI_PROMPT_KEY)) {
    return;
  }

  const action = await vscode.window.showWarningMessage(
    'Salesforce CLI (sf) was not detected. SF Metadata Tracker requires it to function.',
    'Install Instructions',
    "Don't Show Again",
    'Dismiss'
  );

  if (action === 'Install Instructions') {
    vscode.env.openExternal(vscode.Uri.parse('https://developer.salesforce.com/tools/salesforcecli'));
  } else if (action === "Don't Show Again") {
    globalState?.update(SUPPRESS_CLI_PROMPT_KEY, true);
  }
}

/**
 * Clear the CLI cache
 */
export function clearCliCache() {
  cliStatusCache = {
    installed: null,
    version: null,
    resolvedPath: null,
    lastChecked: null,
  };
}
