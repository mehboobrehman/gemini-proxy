' Starts gemini-proxy with truly zero window - not even the brief console
' flash a .bat would cause when double-clicked (Explorer always gives a .bat
' a console host for an instant, no matter how fast it exits; wscript.exe
' running a .vbs never attaches one at all). All the actual startup logic
' (single-instance guard, dependency install, spawning the server) lives in
' run-background.ps1 - this file is just a silent trampoline into it.
Dim shell, fso, scriptDir
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Window style 0 = hidden, waitOnReturn False = fire-and-forget (don't block
' this script waiting for the proxy to exit).
shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\run-background.ps1""", 0, False
