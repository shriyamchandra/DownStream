#!/bin/bash
# Install DownStream macOS Service
# This creates a system service that appears in the right-click Share menu

SERVICE_DIR="$HOME/Library/Services/Download with DownStream.workflow/Contents"
SERVICE_DOC="$SERVICE_DIR/document.wflow"

mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_DOC" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>523</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<true/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>1.0.2</string>
				<key>AMApplication</key>
				<array>
					<string>Automator</string>
				</array>
				<key>AMCategory</key>
				<string>AMCategoryUtilities</string>
				<key>AMIconName</key>
				<string>Automator</string>
				<key>AMKeywords</key>
				<array>
					<string>Shell</string>
					<string>Script</string>
					<string>Command</string>
				</array>
				<key>AMName</key>
				<string>Run Shell Script</string>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>AMRequiredResources</key>
				<array/>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>#!/bin/bash
# DownStream Share Extension
# Receives URLs from macOS Share menu and sends to DownStream app

while read -r line; do
  # Extract URLs from the input
  urls=$(echo "$line" | grep -oE 'https?://[^ ]+')
  for url in $urls; do
    # URL-encode the url parameter
    encoded_url=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$url', safe=''))")
    open "downstream://add?url=${encoded_url}"
  done
done</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/bash</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>1.0.2</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<false/>
				<key>CanShowWhenRun</key>
				<true/>
				<key>GroupID</key>
				<string>0</string>
				<key>OutputUUID</key>
				<string>0</string>
			</dict>
		</dict>
	</array>
	<key>workflowType</key>
	<string>Application</string>
	<key>workflowTypes</key>
	<array>
		<string>Service</string>
	</array>
	<key>serviceInputTypeIdentifier</key>
	<string>com.apple.Safari.address</string>
	<key>serviceOutputTypeIdentifier</key>
	<string>com.apple.Automator.nothing</string>
	<key>serviceProcessesInput</key>
	<integer>0</integer>
	<key>serviceSelectedApplicationBundleIdentifier</key>
	<string>com.apple.Safari</string>
	<key>serviceApplicationPath</key>
	<string>/Applications/Safari.app</string>
	<key>serviceApplicationTargets</key>
	<array>
		<string>com.apple.Safari</string>
		<string>com.google.Chrome</string>
		<string>org.mozilla.firefox</string>
		<string>com.microsoft.edgemac</string>
		<string>com.brave.Browser</string>
		<string>com.vivaldi.Vivaldi</string>
	</array>
</dict>
</plist>
PLIST

echo "DownStream Share Extension installed!"
echo "You can now right-click any link in Safari, Chrome, Firefox, etc."
echo "and select 'Share > Download with DownStream'"
echo ""
echo "Note: You may need to enable it in System Settings > Privacy & Security > Extensions > Share Menu"
