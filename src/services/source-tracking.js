import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as shell from '../lib/shell.js';
import * as logger from '../lib/logger.js';
import * as sfCli from '../lib/sf-cli.js';

/**
 * Source tracking service
 * Handles checking sync status between local files and org
 */

// Cache for org connection status
let orgConnectionCache = {
  connected: false,
  alias: null,
  username: null,
  lastChecked: null,
  expiresAt: null,
  error: null,
};

// Pending promise for org connection check (to prevent concurrent calls)
let pendingOrgConnectionCheck = null;

// Cache for source status (to avoid repeated API calls)
const sourceStatusCache = new Map();

/**
 * Get cache TTL from settings
 * @returns {number} TTL in milliseconds
 */
function getCacheTTL() {
  const config = vscode.workspace.getConfiguration('sfMetadataTracker');
  return (config.get('cacheTTL', 60) || 60) * 1000;
}

/**
 * Check if org is connected and get org info
 * @returns {Promise<{connected: boolean, alias?: string, username?: string, instanceUrl?: string, error?: string, errorType?: string}>}
 */
export async function checkOrgConnection() {
  // Check CLI first (synchronous)
  const cliStatus = sfCli.getCachedCliStatus();
  if (cliStatus.installed === false) {
    return { connected: false, error: 'Salesforce CLI not installed', errorType: 'cli_not_installed' };
  }

  // Check cache first (valid for 5 minutes to avoid issues during long operations)
  if (
    orgConnectionCache.lastChecked &&
    Date.now() - orgConnectionCache.lastChecked < 300000
  ) {
    return {
      connected: orgConnectionCache.connected,
      alias: orgConnectionCache.alias,
      username: orgConnectionCache.username,
      error: orgConnectionCache.error,
      errorType: orgConnectionCache.errorType,
    };
  }

  // If there's already a pending check, wait for it instead of starting a new one
  if (pendingOrgConnectionCheck) {
    return pendingOrgConnectionCheck;
  }

  // Start a new check and store the promise
  pendingOrgConnectionCheck = (async () => {
    try {
      const result = await shell.execCommandWithTimeout(
        'sf org display --json',
        10000
      );
      const data = JSON.parse(result);

      if (data.status === 0 && data.result) {
        orgConnectionCache = {
          connected: true,
          alias: data.result.alias || null,
          username: data.result.username,
          instanceUrl: data.result.instanceUrl,
          lastChecked: Date.now(),
          expiresAt: data.result.expirationDate || null,
          error: null,
          errorType: null,
        };

        return {
          connected: true,
          alias: data.result.alias,
          username: data.result.username,
          instanceUrl: data.result.instanceUrl,
        };
      }

      // Check for specific error messages
      const errorMessage = data.message || 'No default org set';
      orgConnectionCache = {
        connected: false,
        lastChecked: Date.now(),
        error: errorMessage,
        errorType: 'no_default_org',
      };
      return { connected: false, error: errorMessage, errorType: 'no_default_org' };
    } catch (error) {
      // Parse error to determine type
      let errorType = 'unknown';
      let errorMessage = error.message;

      if (errorMessage.includes('No default org')) {
        errorType = 'no_default_org';
        errorMessage = 'No default org set. Use "SF Metadata Tracker: Authorize Org" to connect.';
      } else if (errorMessage.includes('expired') || errorMessage.includes('refresh token')) {
        errorType = 'auth_expired';
        errorMessage = 'Org authentication expired. Please re-authorize.';
      } else if (errorMessage.includes('ENOENT') || errorMessage.includes('not found') || errorMessage.includes('not recognized')) {
        errorType = 'cli_not_installed';
        errorMessage = 'Salesforce CLI (sf) is not installed or not in PATH.';
      }

      orgConnectionCache = {
        connected: false,
        lastChecked: Date.now(),
        error: errorMessage,
        errorType,
      };
      
      logger.log(`Org connection check failed: ${errorMessage}`, 'WARN');
      return { connected: false, error: errorMessage, errorType };
    }
  })();

  try {
    return await pendingOrgConnectionCheck;
  } finally {
    pendingOrgConnectionCheck = null;
  }
}

/**
 * Get the cached org connection info
 * @returns {{connected: boolean, alias?: string, username?: string}}
 */
export function getCachedOrgConnection() {
  return {
    connected: orgConnectionCache.connected,
    alias: orgConnectionCache.alias,
    username: orgConnectionCache.username,
  };
}

/**
 * Clear the org connection cache
 */
export function clearOrgCache() {
  orgConnectionCache = {
    connected: false,
    alias: null,
    username: null,
    lastChecked: null,
    expiresAt: null,
    error: null,
    errorType: null,
  };
  sourceStatusCache.clear();
}

/**
 * Batch fetch metadata info for multiple files of the same type
 * @param {string} metadataType - The Salesforce metadata type (e.g., 'ApexClass')
 * @param {Array<{filePath: string, name: string}>} files - Array of files to query
 * @returns {Promise<Map<string, Object>>} Map of filePath to status data
 */
export async function batchGetFileOrgStatus(metadataType, files) {
  const results = new Map();
  
  if (!files || files.length === 0) {
    return results;
  }

  const orgStatus = await checkOrgConnection();
  if (!orgStatus.connected) {
    files.forEach(f => results.set(f.filePath, { inSync: null, error: 'Not connected to org' }));
    return results;
  }

  // Check cache first and filter out cached files
  const cacheTTL = getCacheTTL();
  const uncachedFiles = [];
  
  for (const file of files) {
    // Normalize path for cache lookup
    const normalizedPath = file.filePath.replace(/\\/g, '/').replace(/-meta\.xml$/, '');
    const cached = sourceStatusCache.get(normalizedPath) || sourceStatusCache.get(file.filePath);
    if (cached && Date.now() - cached.timestamp < cacheTTL) {
      results.set(file.filePath, cached.data);
    } else {
      uncachedFiles.push(file);
    }
  }

  if (uncachedFiles.length === 0) {
    return results;
  }

  try {
    // Build batch query with IN clause
    const names = uncachedFiles.map(f => `'${f.name}'`).join(',');
    const query = buildBatchMetadataQuery(metadataType, names);
    
    if (!query) {
      uncachedFiles.forEach(f => results.set(f.filePath, { inSync: null, error: 'Cannot query this metadata type' }));
      return results;
    }

    const result = await shell.execCommandWithTimeout(
      `sf data query --query "${query}" --json`,
      30000
    );
    const data = JSON.parse(result);

    // Create a map of name -> record for quick lookup
    const recordMap = new Map();
    if (data.status === 0 && data.result?.records) {
      for (const record of data.result.records) {
        const recordName = record.Name || record.DeveloperName;
        recordMap.set(recordName, record);
      }
    }

    // Process each file
    for (const file of uncachedFiles) {
      const record = recordMap.get(file.name);
      // Normalize path for cache storage
      const normalizedPath = file.filePath.replace(/\\/g, '/').replace(/-meta\.xml$/, '');
      
      if (record) {
        const statusData = {
          inSync: null,
          lastModifiedBy: record.LastModifiedBy?.Name || record.LastModifiedById,
          lastModifiedDate: record.LastModifiedDate,
          createdBy: record.CreatedBy?.Name || record.CreatedById,
          createdDate: record.CreatedDate,
          type: metadataType,
          name: file.name,
        };

        // Cache the result with normalized path
        sourceStatusCache.set(normalizedPath, {
          timestamp: Date.now(),
          data: statusData,
        });

        results.set(file.filePath, statusData);
      } else {
        const notFoundData = { inSync: null, error: 'Component not found in org' };
        sourceStatusCache.set(normalizedPath, {
          timestamp: Date.now(),
          data: notFoundData,
        });
        results.set(file.filePath, notFoundData);
      }
    }

    return results;
  } catch (error) {
    logger.log(`Batch status check failed: ${error.message}`, 'WARN');
    uncachedFiles.forEach(f => results.set(f.filePath, { inSync: null, error: error.message }));
    return results;
  }
}

/**
 * Get metadata info for a specific file from org
 * @param {string} filePath - Full path to the file
 * @param {boolean} preferCache - If true, return cached data without querying if available
 * @returns {Promise<{inSync: boolean, lastModifiedBy?: string, lastModifiedDate?: string, type?: string, error?: string}>}
 */
export async function getFileOrgStatus(filePath, preferCache = false) {
  const orgStatus = await checkOrgConnection();
  if (!orgStatus.connected) {
    return { inSync: null, error: 'Not connected to org' };
  }

  // Normalize path for cache lookup
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/-meta\.xml$/, '');
  
  // Check cache - try multiple path variations
  const cacheTTL = getCacheTTL();
  const pathsToCheck = [filePath, normalizedPath];
  
  for (const pathKey of pathsToCheck) {
    const cached = sourceStatusCache.get(pathKey);
    if (cached && Date.now() - cached.timestamp < cacheTTL) {
      return cached.data;
    }
  }
  
  // If preferCache is true and we have any cached data (even slightly stale), use it
  // This prevents redundant queries during decoration refresh
  if (preferCache) {
    for (const pathKey of pathsToCheck) {
      const cached = sourceStatusCache.get(pathKey);
      if (cached) {
        return cached.data;
      }
    }
  }

  try {
    // Determine metadata type from file path
    const metadataInfo = getMetadataTypeFromPath(filePath);
    if (!metadataInfo) {
      return { inSync: null, error: 'Not a Salesforce metadata file' };
    }

    // Query for last modified info
    const query = buildMetadataQuery(metadataInfo);
    if (!query) {
      return { inSync: null, error: 'Cannot query this metadata type' };
    }

    const result = await shell.execCommandWithTimeout(
      `sf data query --query "${query}" --json`,
      15000
    );
    const data = JSON.parse(result);

    if (data.status === 0 && data.result?.records?.length > 0) {
      const record = data.result.records[0];
      const statusData = {
        inSync: null, // We'll determine this separately
        lastModifiedBy: record.LastModifiedBy?.Name || record.LastModifiedById,
        lastModifiedDate: record.LastModifiedDate,
        createdBy: record.CreatedBy?.Name || record.CreatedById,
        createdDate: record.CreatedDate,
        type: metadataInfo.type,
        name: metadataInfo.name,
      };

      // Cache the result with normalized path
      sourceStatusCache.set(normalizedPath, {
        timestamp: Date.now(),
        data: statusData,
      });

      return statusData;
    }

    // Cache the not found result too
    const notFoundData = { inSync: null, error: 'Component not found in org' };
    sourceStatusCache.set(normalizedPath, {
      timestamp: Date.now(),
      data: notFoundData,
    });
    return notFoundData;
  } catch (error) {
    logger.log(`File status check failed: ${error.message}`, 'WARN');
    return { inSync: null, error: error.message };
  }
}

/**
 * Determine metadata type and name from file path
 * @param {string} filePath 
 * @returns {{type: string, name: string, apiName: string} | null}
 */
export function getMetadataTypeFromPath(filePath) {
  const fileName = path.basename(filePath);
  const dirName = path.dirname(filePath);
  const parts = dirName.split(path.sep);

  // Apex Classes
  if (filePath.includes('/classes/') && fileName.endsWith('.cls')) {
    const name = fileName.replace('.cls', '');
    return { type: 'ApexClass', name, apiName: name };
  }

  // Apex Triggers
  if (filePath.includes('/triggers/') && fileName.endsWith('.trigger')) {
    const name = fileName.replace('.trigger', '');
    return { type: 'ApexTrigger', name, apiName: name };
  }

  // Lightning Web Components
  if (filePath.includes('/lwc/')) {
    const lwcIndex = parts.indexOf('lwc');
    if (lwcIndex >= 0 && parts.length > lwcIndex + 1) {
      const name = parts[lwcIndex + 1];
      return { type: 'LightningComponentBundle', name, apiName: name };
    }
  }

  // Aura Components
  if (filePath.includes('/aura/')) {
    const auraIndex = parts.indexOf('aura');
    if (auraIndex >= 0 && parts.length > auraIndex + 1) {
      const name = parts[auraIndex + 1];
      return { type: 'AuraDefinitionBundle', name, apiName: name };
    }
  }

  // Visualforce Pages
  if (filePath.includes('/pages/') && fileName.endsWith('.page')) {
    const name = fileName.replace('.page', '');
    return { type: 'ApexPage', name, apiName: name };
  }

  // Visualforce Components
  if (filePath.includes('/components/') && fileName.endsWith('.component')) {
    const name = fileName.replace('.component', '');
    return { type: 'ApexComponent', name, apiName: name };
  }

  // Flows
  if (filePath.includes('/flows/') && fileName.endsWith('.flow-meta.xml')) {
    const name = fileName.replace('.flow-meta.xml', '');
    return { type: 'Flow', name, apiName: name };
  }

  return null;
}

/**
 * Build SOQL query for metadata info
 * @param {{type: string, name: string}} metadataInfo 
 * @returns {string | null}
 */
function buildMetadataQuery(metadataInfo) {
  const { type, name } = metadataInfo;

  switch (type) {
    case 'ApexClass':
      return `SELECT Id, Name, LastModifiedBy.Name, LastModifiedDate, CreatedBy.Name, CreatedDate FROM ApexClass WHERE Name = '${name}' LIMIT 1`;

    case 'ApexTrigger':
      return `SELECT Id, Name, LastModifiedBy.Name, LastModifiedDate, CreatedBy.Name, CreatedDate FROM ApexTrigger WHERE Name = '${name}' LIMIT 1`;

    case 'ApexPage':
      return `SELECT Id, Name, LastModifiedBy.Name, LastModifiedDate, CreatedBy.Name, CreatedDate FROM ApexPage WHERE Name = '${name}' LIMIT 1`;

    case 'ApexComponent':
      return `SELECT Id, Name, LastModifiedBy.Name, LastModifiedDate, CreatedBy.Name, CreatedDate FROM ApexComponent WHERE Name = '${name}' LIMIT 1`;

    case 'LightningComponentBundle':
      return `SELECT Id, DeveloperName, LastModifiedBy.Name, LastModifiedDate, CreatedBy.Name, CreatedDate FROM LightningComponentBundle WHERE DeveloperName = '${name}' LIMIT 1`;

    case 'AuraDefinitionBundle':
      return `SELECT Id, DeveloperName, LastModifiedBy.Name, LastModifiedDate, CreatedBy.Name, CreatedDate FROM AuraDefinitionBundle WHERE DeveloperName = '${name}' LIMIT 1`;

    case 'Flow':
      return `SELECT Id, DeveloperName, LastModifiedBy.Name, LastModifiedDate, CreatedBy.Name, CreatedDate FROM FlowDefinition WHERE DeveloperName = '${name}' LIMIT 1`;

    default:
      return null;
  }
}

/**
 * Build batch SOQL query for multiple metadata items of the same type
 * @param {string} type - Metadata type
 * @param {string} namesInClause - Comma-separated quoted names for IN clause
 * @returns {string | null}
 */
function buildBatchMetadataQuery(type, namesInClause) {
  switch (type) {
    case 'ApexClass':
      return `SELECT Id, Name, LastModifiedBy.Name, LastModifiedDate, CreatedBy.Name, CreatedDate FROM ApexClass WHERE Name IN (${namesInClause})`;

    case 'ApexTrigger':
      return `SELECT Id, Name, LastModifiedBy.Name, LastModifiedDate, CreatedBy.Name, CreatedDate FROM ApexTrigger WHERE Name IN (${namesInClause})`;

    case 'ApexPage':
      return `SELECT Id, Name, LastModifiedBy.Name, LastModifiedDate, CreatedBy.Name, CreatedDate FROM ApexPage WHERE Name IN (${namesInClause})`;

    case 'ApexComponent':
      return `SELECT Id, Name, LastModifiedBy.Name, LastModifiedDate, CreatedBy.Name, CreatedDate FROM ApexComponent WHERE Name IN (${namesInClause})`;

    case 'LightningComponentBundle':
      return `SELECT Id, DeveloperName, LastModifiedBy.Name, LastModifiedDate, CreatedBy.Name, CreatedDate FROM LightningComponentBundle WHERE DeveloperName IN (${namesInClause})`;

    case 'AuraDefinitionBundle':
      return `SELECT Id, DeveloperName, LastModifiedBy.Name, LastModifiedDate, CreatedBy.Name, CreatedDate FROM AuraDefinitionBundle WHERE DeveloperName IN (${namesInClause})`;

    case 'Flow':
      return `SELECT Id, DeveloperName, LastModifiedBy.Name, LastModifiedDate, CreatedBy.Name, CreatedDate FROM FlowDefinition WHERE DeveloperName IN (${namesInClause})`;

    default:
      return null;
  }
}

/**
 * Format the last modified date for display
 * @param {string} dateString 
 * @returns {string}
 */
export function formatDate(dateString) {
  if (!dateString) return 'Unknown';

  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  if (diffMinutes < 60) {
    return `${diffMinutes} min ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hr ago`;
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toLocaleDateString();
  }
}

// Cache for file differences (local vs org content comparison)
const fileDiffCache = new Map();

/**
 * Compare a local file with its version in the org
 * Retrieves the file from org to a temp directory and compares content
 * @param {string} filePath - Local file path
 * @returns {Promise<{hasDifference: boolean, error?: string}>}
 */
export async function compareFileWithOrg(filePath) {
  const orgStatus = await checkOrgConnection();
  if (!orgStatus.connected) {
    return { hasDifference: false, error: 'Not connected to org' };
  }

  // Check cache first (valid for 60 seconds)
  const cached = fileDiffCache.get(filePath);
  if (cached && Date.now() - cached.timestamp < 60000) {
    return { hasDifference: cached.hasDifference };
  }

  const metadataInfo = getMetadataTypeFromPath(filePath);
  if (!metadataInfo) {
    return { hasDifference: false, error: 'Not a supported metadata type' };
  }

  try {
    // Create a temp directory for retrieval
    const tempDir = path.join(os.tmpdir(), `sf-metadata-compare-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // Build the metadata specifier (e.g., ApexClass:MyClass)
    const metadataSpec = `${metadataInfo.type}:${metadataInfo.name}`;

    logger.log(`Comparing ${metadataSpec} with org...`);

    // Retrieve the component from org to temp directory
    const result = await shell.execCommandWithTimeout(
      `sf project retrieve start --metadata "${metadataSpec}" --output-dir "${tempDir}" --json`,
      60000
    );

    // Parse JSON - handle potential warnings before JSON output
    const data = parseJsonWithWarnings(result);

    if (data.status !== 0) {
      // Component might not exist in org
      if (data.message && data.message.includes('No source-backed components')) {
        fileDiffCache.set(filePath, { hasDifference: false, timestamp: Date.now(), isNew: true });
        cleanupTempDir(tempDir);
        return { hasDifference: false, isNew: true };
      }
      cleanupTempDir(tempDir);
      return { hasDifference: false, error: data.message || 'Retrieve failed' };
    }

    // Find the retrieved file in temp directory
    const retrievedFile = findRetrievedFile(tempDir, metadataInfo);
    
    if (!retrievedFile) {
      cleanupTempDir(tempDir);
      return { hasDifference: false, error: 'Could not find retrieved file' };
    }

    // Compare file contents
    const localContent = fs.readFileSync(filePath, 'utf8');
    const orgContent = fs.readFileSync(retrievedFile, 'utf8');

    // Normalize content for comparison (remove trailing whitespace, normalize line endings)
    const normalizedLocal = normalizeContent(localContent);
    const normalizedOrg = normalizeContent(orgContent);

    const hasDifference = normalizedLocal !== normalizedOrg;

    // Cache the result
    fileDiffCache.set(filePath, { hasDifference, timestamp: Date.now() });

    // Cleanup temp directory
    cleanupTempDir(tempDir);

    logger.log(`${metadataInfo.name}: ${hasDifference ? 'Has differences' : 'In sync'}`);
    return { hasDifference };

  } catch (error) {
    logger.log(`Compare failed for ${filePath}: ${error.message}`, 'WARN');
    return { hasDifference: false, error: error.message };
  }
}

/**
 * Find the retrieved file in the temp directory
 * @param {string} tempDir 
 * @param {Object} metadataInfo 
 * @returns {string|null}
 */
function findRetrievedFile(tempDir, metadataInfo) {
  // SF CLI with --output-dir creates structure like: tempDir/classes/MyClass.cls
  // (direct folder structure without force-app/main/default)
  
  const typeToFolder = {
    ApexClass: 'classes',
    ApexTrigger: 'triggers',
    ApexPage: 'pages',
    ApexComponent: 'components',
    LightningComponentBundle: 'lwc',
    AuraDefinitionBundle: 'aura',
  };

  const typeToExtension = {
    ApexClass: '.cls',
    ApexTrigger: '.trigger',
    ApexPage: '.page',
    ApexComponent: '.component',
  };

  const folder = typeToFolder[metadataInfo.type];
  const extension = typeToExtension[metadataInfo.type];

  // Log directory contents for debugging (only for first file)
  try {
    const topLevelEntries = fs.readdirSync(tempDir);
    if (topLevelEntries.length > 0 && metadataInfo.name === 'AppSettings') {
      logger.log(`Temp dir contents for ${metadataInfo.name}: ${topLevelEntries.join(', ')}`);
      // Check if there's a nested structure
      for (const entry of topLevelEntries) {
        const entryPath = path.join(tempDir, entry);
        if (fs.statSync(entryPath).isDirectory()) {
          const subEntries = fs.readdirSync(entryPath);
          logger.log(`  ${entry}/: ${subEntries.slice(0, 5).join(', ')}${subEntries.length > 5 ? '...' : ''}`);
        }
      }
    }
  } catch {
    // Ignore logging errors
  }

  if (!folder) {
    // For LWC/Aura, need to find the JS file
    return findFileRecursive(tempDir, metadataInfo.name);
  }

  // Try paths in order of likelihood (--output-dir creates direct structure)
  const possiblePaths = [
    // Direct structure (most common with --output-dir)
    path.join(tempDir, folder, `${metadataInfo.name}${extension}`),
    // Unpackaged structure
    path.join(tempDir, 'unpackaged', folder, `${metadataInfo.name}${extension}`),
    // Force-app structure (less common)
    path.join(tempDir, 'force-app', 'main', 'default', folder, `${metadataInfo.name}${extension}`),
    path.join(tempDir, 'main', 'default', folder, `${metadataInfo.name}${extension}`),
  ];

  for (const possiblePath of possiblePaths) {
    if (fs.existsSync(possiblePath)) {
      return possiblePath;
    }
  }

  // Fallback: search recursively
  return findFileRecursive(tempDir, `${metadataInfo.name}${extension}`);
}

/**
 * Recursively find a file by name
 * @param {string} dir 
 * @param {string} filename 
 * @returns {string|null}
 */
function findFileRecursive(dir, filename) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findFileRecursive(fullPath, filename);
        if (found) return found;
      } else if (entry.name === filename || entry.name.includes(filename)) {
        return fullPath;
      }
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Normalize file content for comparison
 * @param {string} content 
 * @returns {string}
 */
function normalizeContent(content) {
  return content
    .replace(/\r\n/g, '\n')  // Normalize line endings
    .replace(/[ \t]+$/gm, '') // Remove trailing whitespace from each line
    .trim(); // Remove leading/trailing whitespace
}

/**
 * Cleanup temp directory
 * @param {string} dir 
 */
function cleanupTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Parse JSON from SF CLI output, handling warnings that appear before JSON
 * @param {string} output 
 * @returns {Object}
 */
function parseJsonWithWarnings(output) {
  // SF CLI may output warnings before the JSON
  // Find the start of JSON (first { or [)
  const jsonStart = output.search(/[{[]/);
  if (jsonStart === -1) {
    throw new Error('No JSON found in output');
  }
  const jsonString = output.substring(jsonStart);
  return JSON.parse(jsonString);
}

/**
 * Batch compare multiple files with org (for prefetch)
 * @param {Array<{filePath: string, name: string, type: string, uri?: vscode.Uri}>} files 
 * @param {Function} progressCallback - Called with (current, total) for progress
 * @param {Function} decorationCallback - Called with (uri, hasDifference, isOrgNewer) after each file is compared
 * @returns {Promise<Map<string, boolean>>} Map of filePath -> hasDifference
 */
export async function batchCompareFilesWithOrg(files, progressCallback, decorationCallback) {
  const results = new Map();
  
  if (files.length === 0) return results;

  const orgStatus = await checkOrgConnection();
  if (!orgStatus.connected) {
    return results;
  }

  // Group files by type
  const filesByType = new Map();
  for (const file of files) {
    if (!filesByType.has(file.type)) {
      filesByType.set(file.type, []);
    }
    filesByType.get(file.type).push(file);
  }

  let processedCount = 0;
  const totalFiles = files.length;

  // Process each type in batches
  for (const [, typeFiles] of filesByType) {
    // Take up to 10 files at a time to avoid too long commands
    const batchSize = 10;
    for (let i = 0; i < typeFiles.length; i += batchSize) {
      const batch = typeFiles.slice(i, i + batchSize);
      
      try {
        // Create temp directory
        const tempDir = path.join(os.tmpdir(), `sf-metadata-batch-${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });

        // Build metadata specifiers - space-separated, each quoted
        const specs = batch.map(f => `"${f.type}:${f.name}"`).join(' ');

        // Retrieve all components in batch
        const result = await shell.execCommandWithTimeout(
          `sf project retrieve start --metadata ${specs} --output-dir "${tempDir}" --json`,
          120000
        );

        // Parse JSON - handle potential warnings before JSON output
        const data = parseJsonWithWarnings(result);

        if (data.status === 0 && data.result?.files) {
          // Build a map of component name -> retrieved file path from the response
          const retrievedFilesMap = new Map();
          for (const fileInfo of data.result.files) {
            // Skip meta.xml files, we want the actual source file
            if (fileInfo.filePath && !fileInfo.filePath.endsWith('-meta.xml')) {
              retrievedFilesMap.set(fileInfo.fullName, fileInfo.filePath);
            }
          }
          
          logger.log(`Retrieved ${retrievedFilesMap.size} files to compare`);
          
          // Compare each file
          for (const file of batch) {
            const retrievedFile = retrievedFilesMap.get(file.name);
            
            if (retrievedFile && fs.existsSync(retrievedFile) && fs.existsSync(file.filePath)) {
              const localContent = fs.readFileSync(file.filePath, 'utf8');
              const orgContent = fs.readFileSync(retrievedFile, 'utf8');
              
              const normalizedLocal = normalizeContent(localContent);
              const normalizedOrg = normalizeContent(orgContent);
              const hasDifference = normalizedLocal !== normalizedOrg;
              const normalizedPath = normalizeFilePath(file.filePath);
              
              // Determine if org is newer by comparing file mod times with cached org LastModifiedDate
              let isOrgNewer = false;
              if (hasDifference) {
                // Try multiple cache key formats - cache stores {timestamp, data: {...}}
                const cachedEntry = sourceStatusCache.get(normalizedPath) || 
                                    sourceStatusCache.get(file.filePath) ||
                                    sourceStatusCache.get(file.name);
                const cachedStatus = cachedEntry?.data;
                
                if (cachedStatus?.lastModifiedDate) {
                  const orgDate = new Date(cachedStatus.lastModifiedDate).getTime();
                  const localStats = fs.statSync(file.filePath);
                  const localDate = localStats.mtime.getTime();
                  isOrgNewer = orgDate > localDate;
                  
                  // Debug logging for files with differences
                  logger.log(`Timestamp check for ${file.name}: orgDate=${new Date(orgDate).toISOString()}, localDate=${new Date(localDate).toISOString()}, isOrgNewer=${isOrgNewer}`);
                } else {
                  // If no cached status, check if file is tracked by git and modified
                  // For now, default to assuming local changes if we can't determine
                  logger.log(`No cached org date for ${file.name}, defaulting to local changes`);
                }
              }
              
              results.set(file.filePath, hasDifference);
              // Store with normalized path for consistent lookups
              const cacheEntry = { hasDifference, isOrgNewer, timestamp: Date.now() };
              fileDiffCache.set(normalizedPath, cacheEntry);
              // Also store original path for direct lookups
              if (normalizedPath !== file.filePath) {
                fileDiffCache.set(file.filePath, cacheEntry);
              }
              
              // Stream decoration update immediately
              if (decorationCallback && file.uri) {
                decorationCallback(file.uri, hasDifference, isOrgNewer);
              }
              
              if (hasDifference) {
                const changeType = isOrgNewer ? 'Org has newer version' : 'Local changes';
                logger.log(`${changeType}: ${file.name} (${file.type})`);
              }
            } else {
              // Log when we can't find the retrieved file
              if (!retrievedFile) {
                logger.log(`No retrieved path for: ${file.name}`, 'WARN');
              } else if (!fs.existsSync(retrievedFile)) {
                logger.log(`Retrieved file not found at: ${retrievedFile}`, 'WARN');
              }
            }
          }
          
          // Clean up retrieved files
          for (const filePath of retrievedFilesMap.values()) {
            try {
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
              }
              // Also remove meta.xml
              const metaPath = filePath + '-meta.xml';
              if (fs.existsSync(metaPath)) {
                fs.unlinkSync(metaPath);
              }
            } catch {
              // Ignore cleanup errors
            }
          }
        } else {
          logger.log(`Retrieve failed for batch: ${data.message || 'Unknown error'}`, 'WARN');
        }

        cleanupTempDir(tempDir);
      } catch (error) {
        logger.log(`Batch compare failed: ${error.message}`, 'WARN');
      }

      // Update progress
      processedCount += batch.length;
      if (progressCallback) {
        progressCallback(processedCount, totalFiles);
      }

      // Small delay between batches
      if (i + batchSize < typeFiles.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }

  return results;
}

/**
 * Normalize file path for consistent cache lookups
 * @param {string} filePath 
 * @returns {string}
 */
function normalizeFilePath(filePath) {
  // Remove -meta.xml suffix if present
  let normalized = filePath.endsWith('-meta.xml') ? filePath.replace('-meta.xml', '') : filePath;
  // Ensure consistent path separators
  return normalized.replace(/\\/g, '/');
}

/**
 * Check if a specific file has differences with org
 * Uses cached diff result
 * @param {string} filePath 
 * @returns {{hasDifference: boolean, isOrgNewer: boolean}}
 */
export function getFileDiffStatus(filePath) {
  const normalizedPath = normalizeFilePath(filePath);
  const defaultResult = { hasDifference: false, isOrgNewer: false, isCompared: false };
  
  // Try exact match first with normalized path
  let cached = fileDiffCache.get(normalizedPath);
  if (cached) {
    return { hasDifference: cached.hasDifference, isOrgNewer: cached.isOrgNewer || false, isCompared: true };
  }
  
  // Try original path
  cached = fileDiffCache.get(filePath);
  if (cached) {
    return { hasDifference: cached.hasDifference, isOrgNewer: cached.isOrgNewer || false, isCompared: true };
  }
  
  // For meta files, check the parent file
  if (filePath.endsWith('-meta.xml')) {
    const parentPath = filePath.replace('-meta.xml', '');
    cached = fileDiffCache.get(parentPath);
    if (cached) {
      return { hasDifference: cached.hasDifference, isOrgNewer: cached.isOrgNewer || false, isCompared: true };
    }
  }
  
  // Try to find by normalized path match
  for (const [cachedPath, cachedData] of fileDiffCache.entries()) {
    if (normalizeFilePath(cachedPath) === normalizedPath) {
      return { hasDifference: cachedData.hasDifference, isOrgNewer: cachedData.isOrgNewer || false, isCompared: true };
    }
  }
  
  return defaultResult;
}

/**
 * Legacy function for backwards compatibility
 * @param {string} filePath 
 * @returns {boolean}
 */
export function hasLocalChanges(filePath) {
  const status = getFileDiffStatus(filePath);
  return status.hasDifference;
}

/**
 * Check if diff cache has entry for a file
 * @param {string} filePath 
 * @returns {boolean}
 */
export function hasDiffCacheEntry(filePath) {
  const cached = fileDiffCache.get(filePath);
  return cached && Date.now() - cached.timestamp < 60000;
}

/**
 * Clear diff cache
 */
export function clearChangesCache() {
  fileDiffCache.clear();
}

/**
 * Get the diff cache (for debugging/status)
 * @returns {Map}
 */
export function getDiffCache() {
  return fileDiffCache;
}

/**
 * Invalidate cache for a specific file
 * @param {string} filePath 
 */
export function invalidateFileCache(filePath) {
  sourceStatusCache.delete(filePath);
  fileDiffCache.delete(filePath);
}

/**
 * Clear all source status caches
 */
export function clearSourceCache() {
  sourceStatusCache.clear();
  fileDiffCache.clear();
}
