' Starts gemini-proxy fully hidden using ONLY Windows Script Host + cmd.exe
' - no PowerShell involved anywhere in the chain. PowerShell script
' execution and WSH are two separate Group Policy switches in most
' corporate lockdowns, so this is worth trying if run.bat/run.ps1 or
' run-background.vbs don't work but `bun run src\server.ts` does. (If WSH
' itself is also disabled, this file won't run at all - fall back to
' run-restricted.bat, which only needs cmd.exe, minimized instead of
' hidden.)
'
' Runs bun directly inside one hidden cmd session rather than via a nested
' `start` - `start` is what creates a new (visible-in-taskbar, even if
' minimized) window; avoiding it entirely is what makes this truly hidden.

Dim shell, fso, scriptDir, port, exec, line, pids, i, waited

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

port = shell.ExpandEnvironmentStrings("%PORT%")
If port = "%PORT%" Or Len(port) = 0 Then port = "8765"

Function LastToken(s)
    Dim parts, j, result
    parts = Split(Trim(s), " ")
    result = ""
    For j = 0 To UBound(parts)
        If Len(Trim(parts(j))) > 0 Then result = Trim(parts(j))
    Next
    LastToken = result
End Function

Function ListeningPids(port)
    Dim d, ex, ln
    Set d = CreateObject("Scripting.Dictionary")
    Set ex = shell.Exec("netstat -ano")
    Do While Not ex.StdOut.AtEndOfStream
        ln = ex.StdOut.ReadLine()
        If InStr(ln, ":" & port & " ") > 0 And InStr(ln, "LISTENING") > 0 Then
            d(LastToken(ln)) = True
        End If
    Loop
    Set ListeningPids = d
End Function

' Only one proxy at a time — stop whatever's already listening (started via
' run.bat, run-background.vbs, run-restricted.bat, or directly) rather than
' refusing to start or running a second instance alongside it.
Set pids = ListeningPids(port)
If pids.Count > 0 Then
    For Each i In pids.Keys
        shell.Run "taskkill /PID " & i & " /F", 0, True
    Next
    waited = 0
    Do While waited < 20
        Set pids = ListeningPids(port)
        If pids.Count = 0 Then Exit Do
        WScript.Sleep 250
        waited = waited + 1
    Loop
End If

If Not fso.FolderExists(scriptDir & "\node_modules") Then
    Set exec = shell.Exec("cmd /c cd /d """ & scriptDir & """ && bun install")
    Do While exec.Status = 0
        WScript.Sleep 200
    Loop
End If

' Window style 0 = hidden, waitOnReturn False = fire-and-forget (don't
' block this script waiting for the proxy to exit).
shell.Run "cmd /c ""cd /d """ & scriptDir & """ && bun run src\server.ts""", 0, False
