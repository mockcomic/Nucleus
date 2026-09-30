# E2E: verify an installed-program (type: app) segment launches via real click.
# Uses the same dropdown data source (src/main/apps.js) to pick the program.
param([int]$Cx = 3000, [int]$Cy = 900, [string]$AppName = 'notepad++', [string]$ProcName = 'notepad++')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if (-not ('Win32.U32' -as [type])) {
  Add-Type -Namespace Win32 -Name U32 -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);'
}
if (-not ('Win32.Watch' -as [type])) {
  Add-Type -Namespace Win32 -Name Watch -MemberDefinition @'
public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
public struct RECT { public int L, T, R, B; }
public static System.Collections.Generic.List<IntPtr> Square(IntPtr[] ignore, int minSize, int maxSize) {
  var found = new System.Collections.Generic.List<IntPtr>();
  EnumProc cb = (h, l) => {
    uint pid; GetWindowThreadProcessId(h, out pid);
    if (!IsWindowVisible(h)) return true;
    RECT r; GetWindowRect(h, out r);
    int w = r.R - r.L, ht = r.B - r.T;
    if (w == ht && w >= minSize && w <= maxSize) found.Add(h);
    return true;
  };
  EnumWindows(cb, IntPtr.Zero);
  return found;
}
public static RECT RectOf(IntPtr h) { RECT r; GetWindowRect(h, out r); return r; }
'@
}
$root = (Get-Location).Path
$elecPids = @(Get-Process electron -EA SilentlyContinue | ForEach-Object Id)
if (-not $elecPids) { Write-Output 'APP NOT RUNNING'; exit 30 }
function Find-Overlay {
  $cands = [Win32.Watch]::Square([IntPtr[]]@(), 300, 1200)
  foreach ($h in $cands) {
    $pid2 = [uint32]0; [Win32.Watch]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
    if ($elecPids -contains $pid2) { return [Win32.Watch]::RectOf($h) }
  }
  return $null
}
function FireHotkey { node -e "require('./src/main/macro').sendChord(['ctrl','alt','space'])" | Out-Null }
function FireEsc { node -e "require('./src/main/macro').sendVk(0x1B)" | Out-Null }

if (Get-Process -Name $ProcName -EA SilentlyContinue) { Write-Output ('PRECONDITION: {0} already running - close it first' -f $ProcName); exit 35 }

foreach ($i in 1..3) { if (-not (Find-Overlay)) { break }; FireEsc; Start-Sleep -Milliseconds 300 }
if (Find-Overlay) { Write-Output 'STUCK VISIBLE'; exit 31 }

$prep = (node tests\click-at.js prepare-app $AppName) -join ''
if (-not $prep) { Write-Output 'PREPARE FAILED'; exit 32 }
$info = $prep | ConvertFrom-Json
Write-Output ('picked installed app: {0}  at  {1}' -f $info.picked, $info.path)
Start-Sleep -Milliseconds 700   # hot-reload

[Win32.U32]::SetCursorPos($Cx, $Cy) | Out-Null; Start-Sleep -Milliseconds 120
FireHotkey
$rect = $null
foreach ($i in 1..12) { Start-Sleep -Milliseconds 120; $rect = Find-Overlay; if ($rect) { break } }
if (-not $rect) { Write-Output 'OVERLAY NEVER APPEARED'; node tests\click-at.js cleanup | Out-Null; exit 33 }
$w = $rect.R - $rect.L
$ccx = $rect.L + [int]($w / 2); $ccy = $rect.T + [int]($w / 2)
$scale = $w / (2 * 210 + 52)

$clickX = $ccx + [int]($info.dx * $scale); $clickY = $ccy + [int]($info.dy * $scale)
[Win32.U32]::SetCursorPos($clickX, $clickY) | Out-Null
Start-Sleep -Milliseconds 250
node tests\click-at.js click | Out-Null

$spawned = $false
foreach ($i in 1..16) { Start-Sleep -Milliseconds 350; if (Get-Process -Name $ProcName -EA SilentlyContinue) { $spawned = $true; break } }
$autohid = -not (Find-Overlay)
node tests\click-at.js cleanup | Out-Null
if ($spawned) {
  Write-Output ('RESULT: PASS - clicking the app segment launched {0} (overlay auto-hid: {1})' -f $ProcName, $autohid)
  Stop-Process -Name $ProcName -Force -EA SilentlyContinue   # clean up the window we opened
  exit 0
} else {
  Write-Output ('RESULT: FAIL - {0} never started (autohid={1})' -f $ProcName, $autohid)
  FireEsc; exit 34
}
