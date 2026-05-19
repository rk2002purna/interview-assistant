Set oShell = CreateObject("WScript.Shell")
oShell.Run "cmd /c cd /d """ & Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1) & """ && npm start", 0, False