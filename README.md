# SF Metadata Tracker

[![VS Code Extension](https://img.shields.io/badge/VS%20Code-Extension-blue?logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=avidev9.sf-metadata-tracker)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.4.0-green.svg)](https://github.com/Avinava/vscode-sf-metadata-tracker/releases)

Track and display sync status indicators for Salesforce metadata files in VS Code. Get real-time visibility into your metadata's org status, including who last modified it, when, and code coverage metrics.

<p align="center">
  <img src="assets/icon.png" alt="SF Metadata Tracker" width="128" height="128">
</p>

## Features

### 📊 Status Bar Integration
- View the sync status of the currently active Salesforce metadata file
- See who last modified the file in the org with **relative time** (e.g., "2 hours ago")
- Quick access to detailed file information with deploy/retrieve actions
- Custom Salesforce-themed status bar icon

### 🎨 File Decorations
- Visual indicators in the Explorer view showing metadata status
- Quickly identify files that differ from the org version
- Color-coded badges for easy recognition:
  - 🟢 **In Sync** - Local file matches org
  - 🟡 **Modified** - Local changes detected
  - 🔵 **New** - File doesn't exist in org yet

### 🔄 Real-time Tracking
- Automatic detection of Salesforce DX projects
- Smart caching to minimize API calls
- Background metadata scanning with progress indicator
- Manual refresh options for on-demand status updates

### 🧪 Code Coverage & Testing
- View code coverage percentage for Apex classes and triggers
- Toggle coverage highlighting directly in the editor
- Visual indicators for covered/uncovered lines
- **Run Apex tests** directly from VS Code with progress indicator
- View detailed test results, failures, and stack traces
- Automatic coverage refresh after test runs
- Context menu integration for quick test execution

### ☁️ Deploy & Retrieve
- Deploy current file to org directly from VS Code
- Retrieve latest version from org
- Context menu integration in Explorer and Editor
- Quick actions from status bar popup

### 🔐 Org Management
- Authorize new orgs without leaving VS Code
- Switch between connected orgs easily
- Clear authentication status indicators

## Supported Metadata Types

- **Apex Classes** (`.cls`)
- **Apex Triggers** (`.trigger`)
- **Lightning Web Components** (LWC)
- **Aura Components**
- **Visualforce Pages** (`.page`)
- **Visualforce Components** (`.component`)
- **Flows** (`.flow-meta.xml`)

## Requirements

- **Visual Studio Code** v1.61.0 or higher
- **Salesforce CLI (sf)** installed and available in PATH
- A **Salesforce DX project** with `sfdx-project.json`
- An authenticated default org connection

## Installation

1. Open VS Code
2. Go to Extensions (`Cmd+Shift+X` on macOS, `Ctrl+Shift+X` on Windows/Linux)
3. Search for "SF Metadata Tracker"
4. Click **Install**

Or install directly from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=avidev9.sf-metadata-tracker).

## Usage

### Automatic Activation
The extension automatically activates when you open a workspace containing an `sfdx-project.json` file.

### Status Bar
Click on the status bar item to see detailed information about the current file:
- Last modified by (with relative time)
- Created by (with relative time)
- Connected org information
- Quick actions: Deploy, Retrieve, Refresh

### Commands
Access these commands via the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

| Command | Description |
|---------|-------------|
| `SF Metadata Tracker: Show File Org Status` | Display detailed org status for the current file |
| `SF Metadata Tracker: Refresh File Status` | Refresh the status of the current file |
| `SF Metadata Tracker: Refresh All File Status` | Clear cache and refresh all file statuses |
| `SF Metadata Tracker: Deploy Current File to Org` | Deploy the current file to the connected org |
| `SF Metadata Tracker: Retrieve Current File from Org` | Retrieve the latest version from org |
| `SF Metadata Tracker: Authorize Org` | Authorize a new Salesforce org |
| `SF Metadata Tracker: Switch Default Org` | Switch to a different connected org |
| `SF Metadata Tracker: Toggle Code Coverage Highlighting` | Show/hide coverage highlighting for Apex files |
| `SF Metadata Tracker: Refresh Code Coverage` | Refresh coverage data from org |
| `SF Metadata Tracker: Run Apex Tests` | Run tests for the current Apex class |

## Extension Settings

Configure the extension in VS Code settings (`Cmd+,` / `Ctrl+,`):

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sfMetadataTracker.showStatusBar` | boolean | `true` | Show file sync status in the status bar |
| `sfMetadataTracker.showFileDecorations` | boolean | `true` | Show sync status decorations on files in explorer |
| `sfMetadataTracker.cacheTTL` | number | `60` | Cache time-to-live in seconds for file status |
| `sfMetadataTracker.showScanSummary` | boolean | `true` | Show a brief summary in status bar after scanning files |
| `sfMetadataTracker.showCoverageStatus` | boolean | `true` | Show code coverage percentage in status bar for Apex files |

## How It Works

1. **Org Connection Check**: The extension verifies your default Salesforce org connection
2. **Metadata Detection**: When you open a supported metadata file, it identifies the metadata type
3. **Status Query**: It queries the org for the component's last modified information
4. **Comparison**: Compares local file content with org version to detect changes
5. **Visual Display**: Shows the status in the status bar and file explorer decorations
6. **Code Coverage**: Fetches and displays coverage data for Apex files

## Troubleshooting

### Extension Not Activating
- Ensure your workspace contains an `sfdx-project.json` file
- Verify that Salesforce CLI is installed: run `sf --version` in terminal

### "No Org" or "Auth Expired" Error
- Check your default org: `sf org display`
- Authenticate to an org: `sf org login web`
- Set a default org: `sf config set target-org <alias>`
- Use the "Authorize Org" command from the extension

### Status Not Updating
- Use "Refresh File Status" command to force an update
- Use "Refresh All File Status" to clear all caches
- Check the cache TTL setting if status seems stale

### Code Coverage Not Showing
- Ensure you have run tests in the org
- Use "Refresh Code Coverage" to fetch latest data
- Coverage only works for Apex classes and triggers

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Development

```bash
# Clone the repository
git clone https://github.com/Avinava/vscode-sf-metadata-tracker.git

# Install dependencies
yarn install

# Run linting
yarn lint

# Build the extension
yarn build

# Package for release
yarn package
```

## Changelog

### v1.4.0
- Added **Run Apex Tests** command with detailed results output
- View test results, failures, stack traces, and coverage in output panel
- Context menu integration for quick test execution
- Added relative time display in tooltips and status popup (e.g., "2 hours ago")
- Added custom Salesforce-themed status bar icon
- Added loading indicators when fetching code coverage
- Improved status bar quick pick with detailed information
- Bug fixes and performance improvements

### v1.3.0
- Added code coverage support for Apex classes and triggers
- Added coverage highlighting in editor
- Added deploy/retrieve functionality
- Added org authorization and switching

### v1.2.0
- Added file decorations in Explorer
- Added background metadata scanning
- Improved caching mechanism

### v1.1.0
- Initial release with status bar integration
- Basic metadata tracking support

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built for the Salesforce developer community
- Powered by VS Code Extension API and Salesforce CLI
