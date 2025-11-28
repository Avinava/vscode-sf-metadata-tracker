import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { EXTENSION_NAME } from './constants.js';
import * as logger from './logger.js';

const execAsync = promisify(exec);

/**
 * Shell command execution utilities
 */

/**
 * Execute a shell command
 * @param {string} command - Command to execute
 * @param {Object} options - Execution options
 * @returns {Promise<string>} - Command stdout
 */
export async function execCommand(command, options = {}) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const execOptions = {
    cwd: workspaceFolder,
    maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
    ...options,
  };

  logger.log(`Executing: ${command}`);

  return new Promise((resolve, reject) => {
    exec(command, execOptions, (error, stdout, stderr) => {
      // Check if command actually failed (exit code != 0)
      // SF CLI often outputs warnings to stderr even on success
      if (error && error.code !== 0) {
        // Check if stderr is just a warning (not a real error)
        const isJustWarning = stderr && 
          (stderr.includes('Warning:') || stderr.includes('update available')) &&
          !stderr.includes('Error:') &&
          stdout && stdout.trim().startsWith('{');
        
        if (isJustWarning) {
          logger.log('Command succeeded (with warnings)');
          resolve(stdout);
        } else {
          logger.log(`Command failed: ${stderr || error.message}`, 'ERROR');
          reject(new Error(`${EXTENSION_NAME}: Failed to execute command "${command}": ${stderr || error.message}`));
        }
      } else {
        logger.log('Command succeeded');
        resolve(stdout);
      }
    });
  });
}

/**
 * Execute command with timeout
 * @param {string} command - Command to execute
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {Object} options - Execution options
 * @returns {Promise<string>}
 */
export async function execCommandWithTimeout(command, timeoutMs = 30000, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    execCommand(command, options)
      .then((result) => {
        clearTimeout(timeout);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

/**
 * Execute command using promisified exec (returns {stdout, stderr})
 * @param {string} command - Command to execute
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function execAsync2(command) {
  return execAsync(command);
}
