' Hub sunucusunu gizli pencerede başlatır (Task Scheduler ONLOGON için)
Set shell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run """" & scriptDir & "\start-hub.cmd""", 0, False
