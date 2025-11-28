# Changelog

All notable changes to the SF Metadata Tracker extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.8.0] - 2025-11-28

### Added

- **Export Code Coverage** - Export coverage data to CSV or JSON format
  - Export button in the coverage panel title bar
  - Choose between CSV (spreadsheet-friendly) or JSON (programmatic) formats
  - Includes summary statistics (org coverage, class counts, status breakdown)
  - Option to open exported file or reveal in file explorer
  - Available via command palette: "SF Metadata Tracker: Export Code Coverage"

## [1.7.0] - 2025-11-28

### Added
- **SF Code Coverage Panel** - New sidebar panel in Explorer showing code coverage for all Apex classes and triggers
  - View org-wide coverage summary with color-coded status
  - See coverage breakdown by class with percentage and line counts
  - Classes sorted by coverage (lowest first to highlight problem areas)
  - Click on any class to open the file and show coverage highlighting
  - Refresh button to reload coverage data from org
  - Auto-refresh after running tests
- **Interactive Coverage Display** - Clicking items in the coverage panel now opens the file and automatically shows coverage line highlighting

### Changed
- Coverage panel automatically refreshes when tests are run

## [1.6.0] - 2025-11-28

### Added
- Code coverage status bar indicator for Apex files
- Coverage percentage display with color-coded thresholds (green ≥75%, yellow 50-74%, red <50%)
- Toggle coverage highlighting command to show/hide covered and uncovered lines in the editor

## [1.5.0] - 2025-11-28

### Added
- **Run Apex Tests** command with detailed results output
- View test results, failures, stack traces, and coverage in output panel
- Context menu integration for quick test execution

### Changed
- Added relative time display in tooltips and status popup (e.g., "2 hours ago")
- Added custom Salesforce-themed status bar icon
- Added loading indicators when fetching code coverage
- Improved status bar quick pick with detailed information

### Fixed
- Bug fixes and performance improvements

## [1.4.0] - 2025-11-27

### Added
- Code coverage support for Apex classes and triggers
- Coverage highlighting in editor (green for covered, red for uncovered lines)
- Deploy current file to org functionality
- Retrieve current file from org functionality
- Org authorization commands (Web, Device, JWT)
- Switch default org command

### Changed
- Improved status bar integration with more detailed information

## [1.3.0] - 2025-11-26

### Added
- File decorations in Explorer view showing metadata sync status
- Background metadata scanning with progress indicator
- Color-coded badges for file status (In Sync, Modified, New)

### Changed
- Improved caching mechanism for better performance
- Reduced API calls with smart caching

## [1.2.0] - 2025-11-25

### Added
- Manual refresh commands for file status
- Refresh all file status command to clear caches

### Changed
- Enhanced metadata type detection

## [1.1.0] - 2025-11-24

### Added
- Initial release with status bar integration
- Basic metadata tracking for Apex classes and triggers
- Support for LWC, Aura, Visualforce pages and components
- Detection of last modified by and created by information
- Automatic Salesforce DX project detection
