param([string]$Version = (Get-Content package.json -Raw | ConvertFrom-Json).version)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Versão inválida' }
$file = Get-Item -LiteralPath "release/Visor-Setup-$Version.exe"
# O CLI do Supabase interpreta 'C:' como esquema; use caminhos relativos dentro de release/ (ignorada pelo git)
$folder = New-Item -ItemType Directory -Path (Join-Path 'release' ('update-' + [guid]::NewGuid().ToString('N')))
function Publish-Object($source,$target,$mime) {
  npx.cmd supabase storage cp (Resolve-Path -Relative $source) "ss:///desktop-updates/$target" --remote=gyqnzjjvugrfpbnfjbrf --experimental --content-type $mime --cache-control no-store --yes
  if ($LASTEXITCODE -ne 0) {throw "Falha ao publicar $target"}
}
try {
  $stream = $file.OpenRead()
  try {
    $buffer = [byte[]]::new(24MB)
    for ($i=0; $stream.Position -lt $stream.Length; $i++) {
      $length = [int][Math]::Min($buffer.Length,$stream.Length-$stream.Position)
      $stream.ReadExactly($buffer,0,$length)
      $part = Join-Path $folder.FullName "$i.bin"
      $out = [IO.File]::Create($part)
      try {$out.Write($buffer,0,$length)} finally {$out.Dispose()}
      Publish-Object $part "$Version/$i.bin" 'application/octet-stream'
    }
  } finally {$stream.Dispose()}
  $manifest = Join-Path $folder.FullName 'latest.json'
  @{version=$Version;size=$file.Length;sha256=(Get-FileHash $file.FullName).Hash.ToLowerInvariant()} | ConvertTo-Json | Set-Content -Encoding utf8NoBOM $manifest
  Publish-Object $manifest 'latest.json' 'application/json'
} finally {
  foreach ($f in $folder.GetFiles()) { $f.Delete() }
  $folder.Delete()
}
