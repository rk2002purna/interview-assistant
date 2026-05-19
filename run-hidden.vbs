Set WshShell = CreateObject("WScript.Shell")
Set oExec = WshShell.Exec("""" & WScript.Arguments(0) & """")