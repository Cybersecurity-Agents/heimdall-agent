@echo off
setlocal
if not defined HEIMDALL_NODE set "HEIMDALL_NODE=node"
"%HEIMDALL_NODE%" "%~dp0..\dist\tools\tsec-cli.js" submit %*
exit /b %errorlevel%
