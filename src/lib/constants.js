/**
 * Extension constants and configuration values
 */

export const EXTENSION_NAME = 'SF Metadata Tracker';
export const EXTENSION_ID = 'sf-metadata-tracker';

/**
 * Salesforce file paths that indicate metadata
 */
export const SALESFORCE_PATHS = [
  '/classes/',
  '/triggers/',
  '/lwc/',
  '/aura/',
  '/pages/',
  '/components/',
  '/flows/',
];

/**
 * Salesforce file extensions to track
 */
export const SALESFORCE_EXTENSIONS = [
  '.cls',
  '.cls-meta.xml',
  '.trigger',
  '.trigger-meta.xml',
  '.page',
  '.page-meta.xml',
  '.component',
  '.component-meta.xml',
  '.js',
  '.js-meta.xml',
  '.html',
  '.css',
];

/**
 * Extended Salesforce paths (includes more metadata types)
 */
export const EXTENDED_SALESFORCE_PATHS = [
  '/classes/',
  '/triggers/',
  '/lwc/',
  '/aura/',
  '/pages/',
  '/components/',
  '/flows/',
  '/objects/',
  '/permissionsets/',
  '/profiles/',
];
