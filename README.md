# SF Metadata Tracker

[![VS Code Extension](https://img.shields.io/badge/VS%20Code-Extension-blue?logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=avidev9.sf-metadata-tracker)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Track and display sync status indicators for Salesforce metadata files in VS Code. Get real-time visibility into your metadata's org status, including who last modified it and when.

<p align="center">
  <img src="assets/icon.png" alt="SF Metadata Tracker" width="128" height="128">
</p>

## Features

### 📊 Status Bar Integration
- View the sync status of the currently active Salesforce metadata file
- See who last modified the file in the org and when
- Quick access to detailed file information

### 🎨 File Decorations
- Visual indicators in the Explorer view showing metadata status
- Quickly identify files that have been recently modified in the org
- Color-coded badges for easy recognition

### 🔄 Real-time Tracking
- Automatic detection of Salesforce DX projects
- Smart caching to minimize API calls
- Manual refresh options for on-demand status updates

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

### Commands
Access these commands via the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

| Command | Description |
|---------|-------------|
| `SF Metadata Tracker: Show File Org Status` | Display detailed org status for the current file |
| `SF Metadata Tracker: Refresh File Status` | Refresh the status of the current file |
| `SF Metadata Tracker: Refresh All File Status` | Clear cache and refresh all file statuses |

## Extension Settings

Configure the extension in VS Code settings (`Cmd+,` / `Ctrl+,`):

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sfMetadataTracker.showStatusBar` | boolean | `true` | Show file sync status in the status bar |
| `sfMetadataTracker.showFileDecorations` | boolean | `true` | Show sync status decorations on files in explorer |
| `sfMetadataTracker.recentlyModifiedHours` | number | `24` | Hours to consider a file as recently modified (shows warning indicator) |
| `sfMetadataTracker.cacheTTL` | number | `60` | Cache time-to-live in seconds for file status |

## How It Works

1. **Org Connection Check**: The extension verifies your default Salesforce org connection
2. **Metadata Detection**: When you open a supported metadata file, it identifies the metadata type
3. **Status Query**: It queries the org for the component's last modified information
4. **Visual Display**: Shows the status in the status bar and file explorer decorations

## Troubleshooting

### Extension Not Activating
- Ensure your workspace contains an `sfdx-project.json` file
- Verify that Salesforce CLI is installed: run `sf --version` in terminal

### "Not Connected to Org" Error
- Check your default org: `sf org display`
- Authenticate to an org: `sf org login web`
- Set a default org: `sf config set target-org <alias>`

### Status Not Updating
- Use "Refresh File Status" command to force an update
- Check the cache TTL setting if status seems stale

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
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built for the Salesforce developer community
- Powered by VS Code Extension API and Salesforce CLI
