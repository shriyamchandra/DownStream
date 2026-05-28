-- Aria2 Streamer - Native UI version
-- Paste this into Script Editor and Save As -> Application

on stripQuotes(s)
	set s2 to s
	if s2 starts with "\"" and s2 ends with "\"" then
		set s2 to text 2 thru -2 of s2
	else if s2 starts with "'" and s2 ends with "'" then
		set s2 to text 2 thru -2 of s2
	end if
	return s2
end stripQuotes

on replaceText(theText, searchString, replacementString)
	set AppleScript's text item delimiters to searchString
	set theItems to every text item of theText
	set AppleScript's text item delimiters to replacementString
	set theText to theItems as string
	set AppleScript's text item delimiters to ""
	return theText
end replaceText

-- When user quits from the Dock, kill background downloader
on quit
	try
		do shell script "PID=$(cat /tmp/aria2.pid 2>/dev/null); if [ -n \"$PID\" ]; then kill $PID; fi"
	end try
	continue quit
end quit

-- Ask for URL
try
	set dialogRes to display dialog "Paste the file URL:" default answer "" with title "Aria2 Streamer" buttons {"Cancel", "OK"} default button "OK"
	set theURL to stripQuotes(text returned of dialogRes)
on error
	return -- Exits script if user cancels
end try

if theURL is "" then
	display alert "No URL provided. Exiting."
	return
end if

-- Ask for output filename
try
	set defaultName to do shell script "basename " & quoted form of theURL & " | sed 's/[?].*$//'"
	if defaultName is "" or defaultName is "/" then set defaultName to "downloaded_video.mp4"
	
	set dialogRes to display dialog "Output filename (leave blank to auto-detect):" default answer defaultName with title "Aria2 Streamer" buttons {"Cancel", "OK"} default button "OK"
	set outName to stripQuotes(text returned of dialogRes)
	if outName is "" then set outName to defaultName
	
	set outName to my replaceText(outName, "/", "_")
on error
	return
end try

-- Confirm download
try
	set confirmRes to display dialog "Will download to ~/Downloads/" & outName & return & return & "Start download?" buttons {"No", "Yes"} default button "Yes" with title "Confirm"
	if button returned of confirmRes is "No" then return
on error
	return
end try

-- Build the shell script to launch aria2c in the background
set bashScriptContent to "#!/bin/bash
DOWNLOAD_DIR=\"$HOME/Downloads\"
OUT=$1
URL=$2

# Cleanup old trackers
rm -f /tmp/aria2_progress.log /tmp/aria2.pid

# Locate aria2c natively or via Homebrew
ARIA2CMD=$(which aria2c 2>/dev/null)
if [ -z \"$ARIA2CMD\" ]; then
  if [ -x \"/opt/homebrew/bin/aria2c\" ]; then
    ARIA2CMD=\"/opt/homebrew/bin/aria2c\"
  elif [ -x \"/usr/local/bin/aria2c\" ]; then
    ARIA2CMD=\"/usr/local/bin/aria2c\"
  else
    echo \"ERROR_NOT_FOUND\" > /tmp/aria2_progress.log
    exit 1
  fi
fi

mkdir -p \"$DOWNLOAD_DIR\"
cd \"$DOWNLOAD_DIR\"

# Launch quietly in background, pipe output to log file, save Process ID
\"$ARIA2CMD\" --dir \"$DOWNLOAD_DIR\" --stream-piece-selector=inorder -c --allow-overwrite=true -x 16 -s 16 --console-log-level=info --summary-interval=1 --timeout=60 --file-allocation=none --auto-file-renaming=false --enable-color=false --out \"$OUT\" \"$URL\" > /tmp/aria2_progress.log 2>&1 &
echo $! > /tmp/aria2.pid
"

set tempScriptPath to "/tmp/aria2_streamer.sh"
do shell script "echo " & quoted form of bashScriptContent & " > " & quoted form of tempScriptPath & "; chmod +x " & quoted form of tempScriptPath

-- Launch background download script
do shell script quoted form of tempScriptPath & " " & quoted form of outName & " " & quoted form of theURL

-- Initialize Native Progress Bar
set progress total steps to 100
set progress completed steps to 0
set progress description to "Downloading " & outName
set progress additional description to "Starting download engine..."

set fileOpened to false
set downloadFinished to false

-- Shell command to poll progress quickly
set pollScript to "PID=$(cat /tmp/aria2.pid 2>/dev/null)
if [ -z \"$PID\" ]; then echo 'STARTING|0|Initializing...|0'; exit 0; fi
kill -0 $PID 2>/dev/null
if [ $? -eq 0 ]; then RUN_STATUS=\"RUNNING\"; else RUN_STATUS=\"STOPPED\"; fi
LINE=$(tail -n 15 /tmp/aria2_progress.log 2>/dev/null | grep '\\[#' | tail -n 1)
PCT=$(echo \"$LINE\" | grep -o '([0-9]*%)' | tr -d '()%' || echo '0')
if [ -z \"$PCT\" ]; then PCT=\"0\"; fi
DESC=$(echo \"$LINE\" | sed 's/.*\\[#[^ ]* //; s/\\].*//')
if [ -z \"$DESC\" ]; then DESC=\"Buffering data...\"; fi
FILE=\"$HOME/Downloads/" & outName & "\"
SIZE=$(stat -f%z \"$FILE\" 2>/dev/null || stat -c%s \"$FILE\" 2>/dev/null || echo 0)
echo \"$RUN_STATUS|$PCT|$DESC|$SIZE\"
"

-- Main Polling Loop
repeat
	delay 1 -- Yields CPU and allows UI events (like Quit) to process
	
	try
		set pollRes to do shell script pollScript
		
		set AppleScript's text item delimiters to "|"
		set resItems to text items of pollRes
		set AppleScript's text item delimiters to ""
		
		if (count of resItems) is 4 then
			set runStatus to item 1 of resItems
			set pctStr to item 2 of resItems
			set descStr to item 3 of resItems
			set sizeStr to item 4 of resItems
			
			-- Update progress bar UI
			try
				set progress completed steps to (pctStr as integer)
			end try
			set progress additional description to descStr
			
			-- Buffer Check: Launch Media Player quietly
			if not fileOpened then
				try
					if (sizeStr as integer) > 200000 then
						set fileOpened to true
						set filePath to do shell script "echo $HOME/Downloads/" & quoted form of outName
						do shell script "(command -v vlc >/dev/null 2>&1 && open -a VLC " & quoted form of filePath & " || ( [ -d \"/Applications/IINA.app\" ] && open -a IINA " & quoted form of filePath & " || open " & quoted form of filePath & " )) >/dev/null 2>&1 &"
					end if
				end try
			end if
			
			-- Exit Condition: Process stopped
			if runStatus is "STOPPED" then
				-- Safety catch in case it was an instant resume/completion
				if not fileOpened and (sizeStr as integer) > 200000 then
					set fileOpened to true
					set filePath to do shell script "echo $HOME/Downloads/" & quoted form of outName
					do shell script "(command -v vlc >/dev/null 2>&1 && open -a VLC " & quoted form of filePath & " || ( [ -d \"/Applications/IINA.app\" ] && open -a IINA " & quoted form of filePath & " || open " & quoted form of filePath & " )) >/dev/null 2>&1 &"
				end if
				set downloadFinished to true
				exit repeat
			end if
		end if
	end try
end repeat

-- Post-download Cleanup & Error Checks
try
	set errCheck to do shell script "grep 'ERROR_NOT_FOUND' /tmp/aria2_progress.log || echo ''"
	if errCheck is not "" then
		display alert "aria2c not found. Please install via Homebrew: brew install aria2"
	end if
end try

-- Reset Progress UI before exiting
set progress completed steps to 100
set progress additional description to "Download complete."
delay 1
