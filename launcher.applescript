-- Aria2 Streamer Web Launcher
-- This script launches the Node.js backend and opens the web browser automatically.

set projectDir to "/Users/shriyamchandra/aria2-streamer"
set serverUrl to "http://localhost:3000"

-- Check if server is already running by pinging the port
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
	-- Start the backend server in a new Terminal window
	tell application "Terminal"
		-- We open it in a terminal so you can easily close it when you're done downloading
		do script "cd " & quoted form of projectDir & " && node server.js"
	end tell
	
	-- Give the server 1.5 seconds to spin up
	delay 1.5
end if

-- Open the default web browser to the dashboard
do shell script "open " & serverUrl
