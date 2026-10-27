$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw '请先安装 Python 3.10 或更新版本并加入 PATH。' }
Write-Host '正在使用最近一次扫描快照重新生成报告。'
python scripts/launch_report.py --preview --open
exit $LASTEXITCODE
