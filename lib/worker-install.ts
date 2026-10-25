// The copy-paste commands that install the worker from Work OS without the repository (Claude › Setup › Computers).
// The device key is never in a command: setup asks for it (hidden), so it stays out of shell history.

export const NODE_DOWNLOAD = 'https://nodejs.org/en/download';

export type InstallInfo = { server: string; sha256: string; version: string };

const SAFE_SERVER = /^https?:\/\/[A-Za-z0-9.:\-[\]]+$/;
const SAFE_HASH = /^[0-9a-f]{64}$/;

export function installCommands({ server, sha256 }: InstallInfo): { windows: string; mac: string } {
  if (!SAFE_SERVER.test(server) || !SAFE_HASH.test(sha256)) throw new Error('bad install info');
  const url = `${server}/worker/work-os-worker.mjs`;
  const windows = [
    `$d="$env:LOCALAPPDATA\\WorkOS"; $f="$d\\work-os-worker.mjs"`,
    `if(-not(Get-Command node -ErrorAction SilentlyContinue)){throw 'Install Node 22 or newer from ${NODE_DOWNLOAD} first'}`,
    `New-Item -ItemType Directory -Force $d | Out-Null`,
    `Invoke-WebRequest "${url}" -OutFile $f`,
    `if((Get-FileHash $f -Algorithm SHA256).Hash -ne '${sha256}'){Remove-Item $f; throw 'Checksum mismatch: the download is not the file Work OS published'}`,
    `node $f setup --server ${server}`,
  ].join('; ');
  const check = `const h=require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex');if(h!=='${sha256}'){console.error('Checksum mismatch: the download is not the file Work OS published');process.exit(1)}`;
  const mac = [
    `command -v node >/dev/null || { echo "Install Node 22 or newer from ${NODE_DOWNLOAD} first"; false; }`,
    `mkdir -p "$HOME/.work-os"`,
    `curl -fsSL "${url}" -o "$HOME/.work-os/work-os-worker.mjs"`,
    `node -e "${check}" "$HOME/.work-os/work-os-worker.mjs"`,
    `node "$HOME/.work-os/work-os-worker.mjs" setup --server ${server}`,
  ].join(' && ');
  return { windows, mac };
}
