/* Azure Trusted Signing hook for electron-builder (win.sign).
 *
 * electron-builder calls the exported function once per signable artifact
 * (app exe, bundled dlls, the NSIS uninstaller, and the finished installer).
 * We shell out to the cross-platform `sign-universal` dotnet tool, which
 * talks to the Trusted Signing account directly — no Windows, no wine,
 * no signtool (see scripts/README-signing or repo docs).
 *
 * One-time rig setup:
 *   dotnet tool:  ~/.dotnet/tools/sign-universal   (NuGet: SignUniversal.Cli)
 *   auth:         `az login --use-device-code` — the tool rides the az CLI
 *                 token via DefaultAzureCredential; an expired login makes
 *                 the build FAIL LOUDLY, which is the point: an unsigned
 *                 release is a mistake, not a fallback.
 */
const { execFileSync } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')

const TOOL = process.env.SIGN_UNIVERSAL_BIN || path.join(os.homedir(), '.dotnet', 'tools', 'sign-universal')

module.exports = async function sign(configuration) {
  const file = configuration.path
  process.stdout.write(`[azure-sign] ${path.basename(file)}\n`)
  execFileSync(TOOL, [
    'sign', file,
    '--trusted-signing-endpoint', 'https://eus.codesigning.azure.net/',
    '--trusted-signing-account', 'kurtis-app-signing',
    '--trusted-signing-certificate-profile', 'electron-public',
    '--timestamper', 'http://timestamp.acs.microsoft.com'
  ], {
    stdio: 'inherit',
    env: { ...process.env, DOTNET_ROOT: path.join(os.homedir(), '.dotnet'),
           PATH: [path.join(os.homedir(), '.dotnet'), process.env.PATH].join(path.delimiter) }
  })
}
