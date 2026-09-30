# E2E click test v2 — locates the real overlay window by rect (square, electron-owned),
# aims the click at its actual center, so physical mouse use during the test can't skew it.
param([int]$Cx = 3000, [int]$Cy = 900)
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
$PROOF = Join-Path $root '.cache\click-proof.txt'
$elecPids = @(Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object Id)
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

# 1. ensure hidden
foreach ($i in 1..3) { if (-not (Find-Overlay)) { break }; FireEsc; Start-Sleep -Milliseconds 300 }
if (Find-Overlay) { Write-Output 'STUCK VISIBLE'; exit 31 }
Write-Output 'overlay hidden: confirmed'

# 2. inject test item
$prep = (node tests\click-at.js prepare) -join ''
if (-not $prep) { Write-Output 'PREPARE FAILED'; exit 32 }
$info = $prep | ConvertFrom-Json
Start-Sleep -Milliseconds 700   # let hot-reload land

# 3. pop the wheel and find it
[Win32.U32]::SetCursorPos($Cx, $Cy) | Out-Null; Start-Sleep -Milliseconds 120
FireHotkey
$rect = $null
foreach ($i in 1..12) { Start-Sleep -Milliseconds 120; $rect = Find-Overlay; if ($rect) { break } }
if (-not $rect) { Write-Output 'OVERLAY NEVER APPEARED'; exit 33 }
$w = $rect.R - $rect.L
$ccx = $rect.L + [int]($w / 2); $ccy = $rect.T + [int]($w / 2)
$scale = $w / (2 * 210 + 52)
Write-Output "overlay found: rect=$($rect.L),$($rect.T) size=${w}px (scale $([Math]::Round($scale,2)))"

# 4. aim at the injected item's segment using the overlay's own geometry
$clickX = $ccx + [int]($info.dx * $scale); $clickY = $ccy + [int]($info.dy * $scale)
[Win32.U32]::SetCursorPos($clickX, $clickY) | Out-Null
Start-Sleep -Milliseconds 250
node tests\click-at.js click | Out-Null
Start-Sleep -Milliseconds 1500

# 5. verify — existence proves execution (prepare unlinks it first); content check is soft
$hidden = -not (Find-Overlay)
$created = Test-Path $PROOF
$content = ''
if ($created) {
  try { $content = (Get-Content $PROOF -Raw -ErrorAction SilentlyContinue) } catch { }
  if ($null -eq $content) { $content = '(empty)' }
  $content = $content.Trim()
}
Write-Output "proof file: created=$created content='$content' autohid=$hidden"
if ($created) {
  Write-Output 'RESULT: PASS — segment click executed the configured command'
  exit 0
} else {
  Write-Output 'RESULT: FAIL — action never ran'
  FireEsc
  exit 34
} finally {
  node tests\click-at.js cleanup | Out-Null
}
