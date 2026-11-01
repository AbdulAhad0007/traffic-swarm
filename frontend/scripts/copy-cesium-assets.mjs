// Copies the runtime files Cesium loads by URL (web workers, textures, WASM) into public/cesium, which is
// generated and git-ignored. Runs before `next dev` and `next build`. CESIUM_BASE_URL points at this folder.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = new URL('../node_modules/cesium/Build/Cesium/', import.meta.url);
const target = new URL('../public/cesium/', import.meta.url);
const FOLDERS = ['Assets', 'ThirdParty', 'Workers'];

if (!existsSync(source)) throw new Error('cesium is not installed: run npm install first');
rmSync(target, { recursive: true, force: true });
for (const folder of FOLDERS) {
  cpSync(new URL(`${folder}/`, source), new URL(`${folder}/`, target), { recursive: true });
}
console.log(`Copied Cesium ${FOLDERS.join(', ')} to ${fileURLToPath(target)}`);
