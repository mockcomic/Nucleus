' Launches Nucleus with no console window (dev mode), fully detached.
' Startup shortcut target: wscript.exe "...\nucleus-launcher\scripts\launch-hidden.vbs"
Dim fso, sh, root, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
cmd = """" & root & "\node_modules\electron\dist\electron.exe"" """ & root & """"
sh.Run cmd, 0, False
