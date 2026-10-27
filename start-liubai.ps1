$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw '请先安装 Python 3.10 或更新版本并加入 PATH。' }
Write-Host '正在只读扫描并生成单文件静态报告；不会启动后台网页服务。'
python scripts/launch_report.py --open
exit $LASTEXITCODE
