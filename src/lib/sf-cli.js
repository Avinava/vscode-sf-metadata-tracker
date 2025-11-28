import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as logger from './logger.js';

/**
 * Salesforce CLI detection and management
 */

// Cache for CLI status
let cliStatusCache = {
  installed: null,
  version: null,
  lastChecked: null,
};

/**
 * Check if Salesforce CLI is installed
 * @returns {Promise<{installed: boolean, version?: string, error?: string}>}
 */
export async function checkSfCliInstalled() {
  // Check cache (valid for 5 minutes)
  if (cliStatusCache.lastChecked && Date.now() - cliStatusCache.lastChecked < 300000) {
    return {
      installed: cliStatusCache.installed,
      version: cliStatusCache.version,
    };
  }

  return new Promise((resolve) => {
    exec('sf --version', { timeout: 10000 }, (error, stdout) => {
      if (error) {
        cliStatusCache = {
          installed: false,
          version: null,
          lastChecked: Date.now(),
        };
        logger.log('Salesforce CLI not found', 'WARN');
        resolve({ installed: false, error: 'Salesforce CLI (sf) is not installed' });
      } else {
        const version = stdout.trim().split('\n')[0];
        cliStatusCache = {
          installed: true,
          version,
          lastChecked: Date.now(),
        };
        logger.log(`Salesforce CLI found: ${version}`);
        resolve({ installed: true, version });
      }
    });
  });
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
 * Show prompt to install Salesforce CLI
 */
export async function promptInstallCli() {
  const action = await vscode.window.showErrorMessage(
    'Salesforce CLI (sf) is not installed. SF Metadata Tracker requires it to function.',
    'Install Instructions',
    'Dismiss'
  );

  if (action === 'Install Instructions') {
    vscode.env.openExternal(vscode.Uri.parse('https://developer.salesforce.com/tools/salesforcecli'));
  }
}

/**
 * Clear the CLI cache
 */
export function clearCliCache() {
  cliStatusCache = {
    installed: null,
    version: null,
    lastChecked: null,
  };
}
