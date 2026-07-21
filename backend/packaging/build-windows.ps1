$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "../..")
$PythonBin = if ($env:PYTHON) { $env:PYTHON } else { "python" }
$DistDir = if ($env:AURIGASQL_BACKEND_DIST_DIR) { $env:AURIGASQL_BACKEND_DIST_DIR } else { Join-Path $RepoRoot "frontend/electron-backend" }

Set-Location $RepoRoot
$env:PYINSTALLER_CONFIG_DIR = Join-Path $RepoRoot "build/pyinstaller-cache"

$PythonVersion = & $PythonBin -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
if (-not $PythonVersion.StartsWith("3.11")) {
  throw "AurigaSQL desktop backend builds require Python 3.11.x; got $PythonVersion from $PythonBin"
}

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
$TargetExe = Join-Path $DistDir "aurigasql-bff.exe"
if (Test-Path $TargetExe) {
  Remove-Item -Force $TargetExe
}

& $PythonBin -m PyInstaller `
  --clean `
  --noconfirm `
  --onefile `
  --name aurigasql-bff `
  --distpath $DistDir `
  --workpath build/pyinstaller-aurigasql-bff `
  --specpath build/pyinstaller-aurigasql-bff `
  --paths backend `
  --paths src `
  --hidden-import api.app `
  --hidden-import runtime.runtime `
  --hidden-import data.bundled_demo `
  --hidden-import data.engines.sqlite `
  --hidden-import data.engines.duckdb `
  --hidden-import data.engines.postgres `
  --hidden-import data.engines.mysql `
  --hidden-import dbagent.agents.sql_agent `
  --hidden-import dbagent.agents.dbtools `
  --hidden-import dbagent.agents.interaction_tools `
  --hidden-import tiktoken_ext.openai_public `
  --collect-all litellm `
  --collect-all sqlglot `
  --collect-all tiktoken `
  --collect-all pydantic_settings `
  backend/packaging/aurigasql_bff.py
