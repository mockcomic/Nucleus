# Pixel-level render verification for the radial overlay.
# Parks the cursor at a known point, triggers the wheel, screenshots the virtual
# desktop, then scans a ray outward from the center asserting the *configured*
# hub / ring1 / ring2 / label colors occur in the correct radial windows
# (auto-detects DPI scale from where the first band begins).
param(
  [int]$Cx = 3000, [int]$Cy = 900,
  [double]$Tol = 6
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if (-not ('Win32.U32' -as [type])) {
  Add-Type -Namespace Win32 -Name U32 -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);'
}

$cfgPath = Join-Path $env:APPDATA 'Radial Wheel\config.json'
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$inner = $cfg.appearance.innerRadius
$outer = $cfg.appearance.outerRadius
$split = $cfg.appearance.ringSplit
$hasRing2 = @($cfg.rings.'2').Count -gt 0
$mid = if ($hasRing2) { $inner + ($outer - $inner) * $split } else { $outer }
$cHub = $cfg.appearance.colors.center.TrimStart('#')
$cR1 = $cfg.appearance.colors.ring1.TrimStart('#')
$cR2 = $cfg.appearance.colors.ring2.TrimStart('#')
$cText = $cfg.appearance.colors.text.TrimStart('#')

[Win32.U32]::SetCursorPos($Cx, $Cy) | Out-Null
Start-Sleep -Milliseconds 150

$root = (Get-Location).Path
Start-Process -FilePath (Join-Path $root 'node_modules\.bin\electron.cmd') -ArgumentList '.', '--show-wheel' -WindowStyle Hidden
Start-Sleep -Milliseconds 700

$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
$g = [Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [Drawing.Point]::Empty, $b.Size)
$g.Dispose()

function Match($p, [string]$hex) {
  $r = [Convert]::ToInt32($hex.Substring(0, 2), 16); $gg = [Convert]::ToInt32($hex.Substring(2, 2), 16); $bb = [Convert]::ToInt32($hex.Substring(4, 2), 16)
  return ([Math]::Abs($p.R - $r) -le $Tol) -and ([Math]::Abs($p.G - $gg) -le $Tol) -and ([Math]::Abs($p.B - $bb) -le $Tol)
}

$ox = $Cx - $b.X; $oy = $Cy - $b.Y
$ray = @()
$maxD = [int]($outer * 3)
for ($d = 1; $d -le $maxD; $d++) { $ray += , $bmp.GetPixel($ox, $oy - $d) }

# DPI scale estimate: where ring1 first appears / where it should appear
$firstR1 = -1
for ($d = 0; $d -lt $ray.Count; $d++) { if (Match $ray[$d] $cR1) { $firstR1 = $d + 1; break } }
if ($firstR1 -lt 0) { $bmp.Save((Join-Path $root '.cache\pixel-check.png')); $bmp.Dispose(); Write-Output 'RESULT: FAIL — ring1 color never appeared on the north ray'; exit 1 }
$sc = [Math]::Round(($firstR1 / $inner) * 4) / 4
if ($sc -lt 0.5 -or $sc -gt 4) { $sc = 1 }
Write-Output "detected scale: $sc (ring1 starts at ${firstR1}px, expected $inner)"

function CountIn([string]$hex, [int]$d0, [int]$d1) {
  $n = 0
  for ($d = [Math]::Max(1, $d0); $d -le [Math]::Min($ray.Count, $d1); $d++) { if (Match $ray[$d - 1] $hex) { $n++ } }
  return $n
}

$hubN = CountIn $cHub 1 ([int]($inner * $sc - 6))
$r1N = CountIn $cR1 ([int]($inner * $sc + 6)) ([int]($mid * $sc - 6))
# label glyphs are thin AA strokes — detect bright text pixels instead of an exact color match
$txN = 0
for ($d = [Math]::Max(1, [int]($inner * $sc + 6)); $d -le [Math]::Min($ray.Count, [int]($mid * $sc - 6)); $d++) {
  $p = $ray[$d - 1]; if ($p.R -gt 110 -and $p.G -gt 120 -and $p.B -gt 130) { $txN++ }
}
$r2N = 999
if ($hasRing2) { $r2N = CountIn $cR2 ([int]($mid * $sc + 6)) ([int]($outer * $sc - 6)) }

$shot = Join-Path $root '.cache\pixel-check.png'
New-Item -ItemType Directory -Force -Path (Split-Path $shot) | Out-Null
$bmp.Save($shot); $bmp.Dispose()

Write-Output "hub-color pixels:    $hubN (window 1..$([int]($inner*$sc-6)))"
Write-Output "ring1 pixels:        $r1N (window $([int]($inner*$sc+6))..$([int]($mid*$sc-6)))"
Write-Output "label-text pixels:   $txN (same window)"
Write-Output "ring2 pixels:        $r2N (window $([int]($mid*$sc+6))..$([int]($outer*$sc-6)))"

$pass = ($hubN -ge 10) -and ($r1N -ge 10) -and ($txN -ge 1) -and ($r2N -ge 10)
if ($pass) { Write-Output 'RESULT: PASS — wheel rendered: hub + inner ring + labels + outer ring all in place' }
else { Write-Output 'RESULT: FAIL — one or more bands missing'; exit 1 }
