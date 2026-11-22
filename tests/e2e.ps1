# e2e.ps1 -- automated smoke + E2E regression pass for the working-tree app.
#
# WHAT IT RUNS (default: all three, in order):
#   render -- pop the wheel, screenshot the screen, verify the painted hub /
#            ring1 / ring2 band colors and label text against config.json.
#   click  -- inject a ZZTEST command segment, aim at its slice, inject a real
#            mouse click, verify the segment's action executed (proof file).
#   app    -- same with an app segment (default notepad): verify the click
#            launches the app, then kill the spawned process.
#
# WHY IT POPS THE WHEEL INSTEAD OF PRESSING THE HOTKEY:
# synthesized keyboard events (SendInput vk *or* scancode) do not reliably
# reach Electron globalShortcut in headless/agent shells, so this script pops
# the wheel through the app's own second-instance --show-wheel path instead.
# (Mouse injection works everywhere, so the click checks are fully real.)
#
# USAGE
#   npm run test:smoke          # render only
#   npm run test:e2e            # render + click + app
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests/e2e.ps1 -Checks click
#   -Config <path>              # config to drive/verify (default .dev-userdata\config.json)
#   -AppName <query>            # app used by the 'app' check (default notepad)
#   -KeepRunning                # leave the wheel visible at the end (debug)
#
# INSTANCE: runs against the working-tree dev instance. If one isn't already
# running (electron --user-data-dir=.dev-userdata), this script starts one
# hidden and stops it again on exit. If one is already running it is reused
# and left running. Exit code 0 = every requested check passed.
#
# NOTE: this physically takes over the mouse (AGENTS.md): SetCursorPos moves +
# one SendInput click per click/app check; the cursor position is restored.

param(
  [string[]]$Checks = @('render', 'click', 'app'),
  [string]$Config = '',
  [string]$AppName = 'notepad',
  [switch]$KeepRunning
)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
Set-Location $Repo
if (-not $Config) { $Config = Join-Path $Repo '.dev-userdata\config.json' }
New-Item -ItemType Directory -Force -Path (Join-Path $Repo '.cache') | Out-Null
# harnesses often export this; a child electron would then run as plain node and die
Remove-Item Env:\ELECTRON_RUN_AS_NODE -EA SilentlyContinue
$env:NUCLEUS_CONFIG = $Config
$Proof = Join-Path $Repo '.cache\click-proof.txt'

# ---- win32 helpers -------------------------------------------------------
try { Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X, Y; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }
  public static int[] FirstSquare() {              // returns {L,T,w} or null -- C#-side so PS pipelines can't flatten it
    object box = null;
    EnumProc cb = (h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (box != null || !IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r);
      int w = r.R - r.L, ht = r.B - r.T;
      if (w == ht && w >= 300 && w <= 1200) box = new int[]{r.L, r.T, w};
      return true;
    };
    EnumWindows(cb, IntPtr.Zero);
    return (int[])box;
  }
}
'@ } catch { }   # already loaded on reruns in one session
# physical-pixel coordinates (5.1 is only system-DPI-aware by default; no-op when already aware)
try { [void][W32]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }
try { [void][W32]::SetProcessDPIAware() } catch { }
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
$vsr = [System.Windows.Forms.SystemInformation]::VirtualScreen
$orig = New-Object W32+P; [void][W32]::GetCursorPos([ref]$orig)

function Find-Overlay { [W32]::FirstSquare() }
function Park([int[]]$rect) {
  # put the cursor well outside the wheel circle (clamped inside the virtual desktop)
  if (-not $rect) { [void][W32]::SetCursorPos($vsr.X + 8, $vsr.Y + 8); return }
  $L = $rect[0]; $T = $rect[1]; $w = $rect[2]
  # parens are load-bearing: the comma binds tighter than '-', `@($L - $w, ...)` parses as array-minus-array
  $xs = @( ($L - $w), ($L + 2 * $w), ($L - $w), ($L + 2 * $w) )
  $ys = @( ($T - $w), ($T + 2 * $w), ($T + 2 * $w), ($T - $w) )
  for ($ci = 0; $ci -lt 4; $ci++) {
    $x = [int][math]::Max($vsr.X + 8, [math]::Min($vsr.Right - 8, $xs[$ci]))
    $y = [int][math]::Max($vsr.Y + 8, [math]::Min($vsr.Bottom - 8, $ys[$ci]))
    [void][W32]::SetCursorPos($x, $y); return
  }
}
function Pop-Wheel {
  cmd /c "npm run start:agent -- --show-wheel >nul 2>&1"   # stderr notices would trip EAP=Stop
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 200; $r = Find-Overlay; if ($r) { return $r } }
  return $null
}
function Dismiss-Wheel {
  # Dismiss with the app's own gestures. A click landing on the hub is a
  # dismiss (wheel-core decideMarking 'onHub' -> api.dismiss); it also gives
  # the window focus, after which the blur-dismiss path (windows.js:111,
  # losing focus to the desktop) works as backup -- a never-focused visible
  # wheel cannot blur, so the hub click has to come first.
  # Returns $true once no overlay window is visible.
  for ($i = 0; $i -lt 5; $i++) {
    $r = Find-Overlay; if (-not $r) { return $true }
    [void][W32]::SetCursorPos([int]($r[0] + $r[2] / 2), [int]($r[1] + $r[2] / 2))
    Start-Sleep -Milliseconds 150
    node tests\click-at.js click | Out-Null
    Start-Sleep -Milliseconds 300
    if (-not (Find-Overlay)) { return $true }
    Park $r
    try { (New-Object -ComObject WScript.Shell).AppActivate('Program Manager') | Out-Null } catch { }
    Start-Sleep -Milliseconds 400
  }
  return (-not (Find-Overlay))
}
function Ensure-Hidden {
  if (-not (Dismiss-Wheel)) { Write-Host 'WARN: wheel still visible before check (auto-dismiss did not take)' }
}
function Capture {
  $b = New-Object System.Drawing.Bitmap $vsr.Width, $vsr.Height
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.CopyFromScreen($vsr.X, $vsr.Y, 0, 0, $b.Size)
  $g.Dispose(); return $b
}
function Hex2($h) { @{ r = [convert]::ToInt32($h.Substring(1, 2), 16); g = [convert]::ToInt32($h.Substring(3, 2), 16); b = [convert]::ToInt32($h.Substring(5, 2), 16) } }
function Near2($px, $c, $tol) {
  return ([math]::Abs($px.R - $c.r) -le $tol) -and ([math]::Abs($px.G - $c.g) -le $tol) -and ([math]::Abs($px.B - $c.b) -le $tol)
}

# ---- dev instance: reuse, or start and remember to stop ------------------
$mainProc = $null
$dev = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -EA SilentlyContinue |
        Where-Object { $_.CommandLine -match '\.dev-userdata' } | Select-Object -First 1
if (-not $dev) {
  Write-Host 'no dev instance -- starting one (electron . --hidden --no-sandbox --user-data-dir=.dev-userdata)'
  $exe = Join-Path $Repo 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path $exe)) { Write-Host 'FAIL: no node_modules\electron -- run npm install first'; exit 2 }
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $exe
  $startInfo.Arguments = """$Repo"" --hidden --no-sandbox --user-data-dir=.dev-userdata"
  $startInfo.WorkingDirectory = $Repo
  $startInfo.UseShellExecute = $true
  $mainProc = [Diagnostics.Process]::Start($startInfo)
  $ready = $false
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 400
    $d2 = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -EA SilentlyContinue |
          Where-Object { $_.CommandLine -match '\.dev-userdata' } | Select-Object -First 1
    if ($d2) { $ready = $true; break }
  }
  if (-not $ready) { Write-Host 'FAIL: dev instance did not come up'; exit 3 }
  Start-Sleep -Milliseconds 1500   # let hotkey/register + config watch settle
}

$script:Results = [ordered]@{}
try {
  # ---------- render ----------
  if ($Checks -contains 'render') {
    Ensure-Hidden
    $rect = Pop-Wheel
    if ($rect) {
      Park $rect                                   # no hover: flat, un-dimmed colors
      Start-Sleep -Milliseconds 250
      $bmp = Capture
      $cfg = Get-Content $Config -Raw | ConvertFrom-Json
      $ap = $cfg.appearance
      $s = $rect[2] / (2 * $ap.outerRadius + 52)   # px per logical unit (window = wheel + 26 pad)
      $cx = [int]($rect[0] + $rect[2] / 2) - $vsr.X
      $cy = [int]($rect[1] + $rect[2] / 2) - $vsr.Y
      $cHub = Hex2 $ap.colors.center; $cR1 = Hex2 $ap.colors.ring1; $cR2 = Hex2 $ap.colors.ring2
      $inner = $ap.innerRadius * $s; $outer = $ap.outerRadius * $s
      $mid = $inner + ($outer - $inner) * ($(if (@($cfg.rings.'2').Count) { $ap.ringSplit } else { 1 }))
      $cnt = @{ hub = 0; ring1 = 0; ring2 = 0; label = 0 }
      $rdx = @(0, 0, -1, 1); $rdy = @(-1, 1, 0, 0)
      for ($ri = 0; $ri -lt 4; $ri++) { $ray = @($rdx[$ri], $rdy[$ri])
        for ($d = 3; $d -le $outer + 6; $d += 1) {
          foreach ($jit in -1, 0, 1) {             # thin rays miss AA edges; sample 3 columns
            $x = $cx + $ray[0] * $d + $(if ($ray[0]) { $jit } else { 0 })
            $y = $cy + $ray[1] * $d + $(if ($ray[1]) { $jit } else { 0 })
            if ($x -lt 0 -or $y -lt 0 -or $x -ge $bmp.Width -or $y -ge $bmp.Height) { continue }
            $px = $bmp.GetPixel($x, $y)
            if ($d -lt $inner -and (Near2 $px $cHub 6)) { $cnt.hub++ }
            elseif ($d -lt $mid -and (Near2 $px $cR1 6)) { $cnt.ring1++ }
            elseif ($d -lt $outer -and (Near2 $px $cR2 6)) { $cnt.ring2++ }
            # text only counts inside the painted disc (labels render at 0.85 alpha);
            # gating by radius keeps a bright desktop behind the transparent corners out
            if ($d -gt $inner * 0.4 -and $d -lt $outer + 3 -and $px.R -gt 185 -and $px.G -gt 185 -and $px.B -gt 190) { $cnt.label++ }
          }
        }
      }
      $crop = New-Object System.Drawing.Rectangle ([math]::Max(0, $cx - $outer - 60)), ([math]::Max(0, $cy - $outer - 60)),
        ([math]::Min($bmp.Width - [math]::Max(0, $cx - $outer - 60), 2 * $outer + 120)), ([math]::Min($bmp.Height - [math]::Max(0, $cy - $outer - 60), 2 * $outer + 120))
      $bmp.Clone($crop, $bmp.PixelFormat) | ForEach-Object { $_.Save((Join-Path $Repo '.cache\e2e-render-crop.png')); $_.Dispose() }
      $bmp.Dispose()
      $ok = $cnt.hub -ge 10 -and $cnt.ring1 -ge 10 -and $cnt.ring2 -ge 10 -and $cnt.label -ge 1
      Write-Host ("render: hub={0} ring1={1} ring2={2} label={3} -> {4}  (crop: .cache\e2e-render-crop.png)" -f $cnt.hub, $cnt.ring1, $cnt.ring2, $cnt.label, $(if ($ok) { 'PASS' } else { 'FAIL' }))
      $Results['render'] = $ok
      [void](Dismiss-Wheel)       # blur-dismiss again for the next check
    } else { Write-Host 'render: FAIL -- wheel never appeared'; $Results['render'] = $false }
  }

  # ---------- click ----------
  if ($Checks -contains 'click') {
    Ensure-Hidden
    node tests\click-at.js cleanup | Out-Null      # in case a previous aborted run left ZZTEST
    $j = (node tests\click-at.js prepare | ConvertFrom-Json)
    if (-not $j -or $null -eq $j.dx) { Write-Host 'click: FAIL -- prepare printed no JSON'; $Results['click'] = $false }
    else {
      Start-Sleep -Milliseconds 800                # file-watch hot-reload
      $rect = Pop-Wheel
      if (-not $rect) { Write-Host 'click: FAIL -- wheel never appeared'; $Results['click'] = $false }
      else {
        $L = $rect[0]; $T = $rect[1]; $w = $rect[2]
        $scale = $w / (2 * 210 + 52)               # matches repo click-e2e: cfg outer 210, pad 26
        $cx = [int]($L + $w / 2 + $j.dx * $scale); $cy = [int]($T + $w / 2 + $j.dy * $scale)
        [void][W32]::SetCursorPos($cx, $cy)
        Start-Sleep -Milliseconds 120
        node tests\click-at.js click
        $ok = $false
        if ($LASTEXITCODE -eq 0) {
          for ($i = 0; $i -lt 10; $i++) { Start-Sleep -Milliseconds 200; if (Test-Path $Proof) { $ok = $true; break } }
        }
        Write-Host ("click: target {0},{1} -> {2}" -f $cx, $cy, $(if ($ok) { 'PASS (action proof file written)' } else { 'FAIL (action never ran)' }))
        $Results['click'] = $ok
        node tests\click-at.js cleanup | Out-Null
        Remove-Item $Proof -EA SilentlyContinue
        [void](Dismiss-Wheel)
      }
    }
  }

  # ---------- app ----------
  if ($Checks -contains 'app') {
    Ensure-Hidden
    $j = (node tests\click-at.js prepare-app $AppName | ConvertFrom-Json)
    if (-not $j -or $null -eq $j.dx) { Write-Host 'app: FAIL -- prepare-app printed no JSON (no matching app?)'; $Results['app'] = $false }
    else {
      Write-Host "app: picked '$($j.picked)' -> $($j.path)"
      $procGlob = [io.path]::GetFileNameWithoutExtension($j.path) + '*'   # e.g. notepad++* -- kill list matches the picked exe
      $before = @(Get-Process -EA SilentlyContinue | Where-Object { $_.Name -like $procGlob } | ForEach-Object Id)
      Start-Sleep -Milliseconds 800
      $rect = Pop-Wheel
      if (-not $rect) { Write-Host 'app: FAIL -- wheel never appeared'; $Results['app'] = $false }
      else {
        $L = $rect[0]; $T = $rect[1]; $w = $rect[2]
        $scale = $w / (2 * 210 + 52)
        $cx = [int]($L + $w / 2 + $j.dx * $scale); $cy = [int]($T + $w / 2 + $j.dy * $scale)
        [void][W32]::SetCursorPos($cx, $cy)
        Start-Sleep -Milliseconds 120
        node tests\click-at.js click
        $new = @(); $ok = $false
        for ($i = 0; $i -lt 10; $i++) {
          Start-Sleep -Milliseconds 400
          $new = @(Get-Process -EA SilentlyContinue | Where-Object { $_.Name -like $procGlob -and $before -notcontains $_.Id } | ForEach-Object Id)
          if ($new) { $ok = $true; break }
        }
        Write-Host ("app: target {0},{1} -> {2}" -f $cx, $cy, $(if ($ok) { "PASS (launched pid $($new[0]))" } else { 'FAIL (no new process)' }))
        $Results['app'] = $ok
        foreach ($p in $new) { Stop-Process -Id $p -Force -EA SilentlyContinue }
        node tests\click-at.js cleanup | Out-Null
        [void](Dismiss-Wheel)
      }
    }
  }
}
finally {
  if (-not $KeepRunning) {
    node tests\click-at.js cleanup | Out-Null
    [void](Dismiss-Wheel)
    [void][W32]::SetCursorPos($orig.X, $orig.Y)
    if ($mainProc) {
      try { & taskkill /PID $mainProc.Id /T /F 2>&1 | Out-Null } catch { }
      Write-Host 'dev instance started by this run was stopped again'
    }
  }
}

$fails = @($Results.Values | Where-Object { -not $_ })
$lines = foreach ($e in $Results.GetEnumerator()) {
  $v = if ($e.Value) { 'PASS' } else { 'FAIL' }
  $e.Key + '=' + $v
}
Write-Host ('---- e2e summary: ' + ($lines -join ' '))
exit $(if ($fails.Count) { 1 } else { 0 })
