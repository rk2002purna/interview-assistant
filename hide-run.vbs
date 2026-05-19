Const HIDDEN_WINDOW = 12
Set objShell = CreateObject("Shell.Application")
Set objFolder = objShell.Namespace(0)
Set objFolderItem = objFolder.ParseName("WScript.exe")
Set objVerb = objFolderItem.Verbs()
For i = 0 To objVerb.Count - 1
    If objVerb.Item(i) = "Hi&dden" Then
        objVerb.Item(i).DoIt
        Exit For
    End If
Next

Dim objExec
Set objExec = CreateObject("WScript.Shell").Exec("cmd /c cd /d """ & WScript.Arguments(1) & """ && npm start")
Do While objExec.Status = 0
    WScript.Sleep 100
Loop