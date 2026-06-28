-- DownStream Web Launcher (Electron mode)
-- Launches the backend and opens the web UI.
-- Supports the restructured frontend/ + backend/ layout.
-- For custom ports: run from Terminal with PORT=3999 instead, or edit below.

-- Compute project directory relative to this script (works after moving the project)
set projectDir to (POSIX path of (container of (path to me) as alias))

-- Default server URL (change if you always use a custom port)
set serverUrl to "http://localhost:3000"

-- Check if server is already running
try
	set httpCode to do shell script "curl -s -o /dev/null -w \"%{http_code}\" " & serverUrl
	if httpCode is "200" then
		set isRunning to true
	else
		set isRunning to false
	end if
on error
	set isRunning to false
end try

if not isRunning then
	-- Start using current structure (respects PORT env if you set it in the do script)
	tell application "Terminal"
		do script "cd " & quoted form of projectDir & " && node backend/server.js"
	end tell
	delay 1.5
end if

do shell script "open " & serverUrl
