import * as vscode from 'vscode';
import * as path from 'path';
import * as shell from '../lib/shell.js';
import * as logger from '../lib/logger.js';

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
};

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
 * @returns {Promise<{connected: boolean, alias?: string, username?: string, instanceUrl?: string, error?: string}>}
 */
export async function checkOrgConnection() {
  try {
    // Check cache first (valid for 30 seconds)
    if (
      orgConnectionCache.lastChecked &&
      Date.now() - orgConnectionCache.lastChecked < 30000
    ) {
      return {
        connected: orgConnectionCache.connected,
        alias: orgConnectionCache.alias,
        username: orgConnectionCache.username,
      };
    }

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
      };

      return {
        connected: true,
        alias: data.result.alias,
        username: data.result.username,
        instanceUrl: data.result.instanceUrl,
      };
    }

    orgConnectionCache.connected = false;
    orgConnectionCache.lastChecked = Date.now();
    return { connected: false, error: 'No default org set' };
  } catch (error) {
    orgConnectionCache.connected = false;
    orgConnectionCache.lastChecked = Date.now();
    logger.log(`Org connection check failed: ${error.message}`, 'WARN');
    return { connected: false, error: error.message };
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
  };
  sourceStatusCache.clear();
}

/**
 * Get source tracking status for the project
 * @returns {Promise<{status: string, local: Array, remote: Array, conflicts: Array, error?: string}>}
 */
export async function getSourceTrackingStatus() {
  const orgStatus = await checkOrgConnection();
  if (!orgStatus.connected) {
    return { status: 'disconnected', local: [], remote: [], conflicts: [], error: orgStatus.error };
  }

  try {
    const result = await shell.execCommandWithTimeout(
      'sf project retrieve preview --json',
      30000
    );
    const data = JSON.parse(result);

    if (data.status === 0) {
      const remote = data.result?.toRetrieve || [];
      const conflicts = data.result?.conflicts || [];

      return {
        status: remote.length > 0 || conflicts.length > 0 ? 'changes' : 'synced',
        local: [],
        remote,
        conflicts,
      };
    }

    return { status: 'unknown', local: [], remote: [], conflicts: [] };
  } catch (error) {
    logger.log(`Source tracking check failed: ${error.message}`, 'WARN');
    return { status: 'error', local: [], remote: [], conflicts: [], error: error.message };
  }
}

/**
 * Get metadata info for a specific file from org
 * @param {string} filePath - Full path to the file
 * @returns {Promise<{inSync: boolean, lastModifiedBy?: string, lastModifiedDate?: string, type?: string, error?: string}>}
 */
export async function getFileOrgStatus(filePath) {
  const orgStatus = await checkOrgConnection();
  if (!orgStatus.connected) {
    return { inSync: null, error: 'Not connected to org' };
  }

  // Check cache
  const cacheKey = filePath;
  const cached = sourceStatusCache.get(cacheKey);
  const cacheTTL = getCacheTTL();
  if (cached && Date.now() - cached.timestamp < cacheTTL) {
    return cached.data;
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

      // Cache the result
      sourceStatusCache.set(cacheKey, {
        timestamp: Date.now(),
        data: statusData,
      });

      return statusData;
    }

    return { inSync: null, error: 'Component not found in org' };
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
function getMetadataTypeFromPath(filePath) {
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

/**
 * Check if there are remote changes for the current project
 * @returns {Promise<{hasChanges: boolean, count: number, changes: Array}>}
 */
export async function checkRemoteChanges() {
  const orgStatus = await checkOrgConnection();
  if (!orgStatus.connected) {
    return { hasChanges: false, count: 0, changes: [], error: 'Not connected' };
  }

  try {
    const result = await shell.execCommandWithTimeout(
      'sf project retrieve preview --json',
      30000
    );
    const data = JSON.parse(result);

    if (data.status === 0) {
      const changes = data.result?.toRetrieve || [];
      return {
        hasChanges: changes.length > 0,
        count: changes.length,
        changes: changes.slice(0, 10), // Limit to first 10 for display
      };
    }

    return { hasChanges: false, count: 0, changes: [] };
  } catch (error) {
    logger.log(`Remote changes check failed: ${error.message}`, 'WARN');
    return { hasChanges: false, count: 0, changes: [], error: error.message };
  }
}

/**
 * Invalidate cache for a specific file
 * @param {string} filePath 
 */
export function invalidateFileCache(filePath) {
  sourceStatusCache.delete(filePath);
}

/**
 * Clear all source status caches
 */
export function clearSourceCache() {
  sourceStatusCache.clear();
}
