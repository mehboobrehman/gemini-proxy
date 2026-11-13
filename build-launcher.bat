@echo off
set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set ICON=icon.ico
set SOURCE=launcher.cs
set REFS=/reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll

echo Building launcher.exe...
"%CSC%" /target:winexe /debug- /optimize+ /define:RELEASE,TRACE /out:launcher.exe /win32icon:%ICON% %REFS% %SOURCE%

echo Building gemini-proxy-launcher-debug.exe...
"%CSC%" /target:winexe /debug+ /define:DEBUG,TRACE /out:gemini-proxy-launcher-debug.exe /win32icon:%ICON% %REFS% %SOURCE%

echo Building gemini-proxy-launcher-release.exe...
"%CSC%" /target:winexe /debug- /optimize+ /define:RELEASE,TRACE /out:gemini-proxy-launcher-release.exe /win32icon:%ICON% %REFS% %SOURCE%

echo Done.
