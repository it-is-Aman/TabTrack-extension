/**
 * Packages src/ into dist/tabtrack-<version>.zip for the Chrome Web Store.
 * Fails if manifest.json and package.json disagree on the version.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'src/manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

if (manifest.version !== pkg.version) {
    console.error(`Version mismatch: manifest ${manifest.version} vs package.json ${pkg.version}`);
    process.exit(1);
}

const distDir = resolve(root, 'dist');
const zipPath = resolve(distDir, `tabtrack-${manifest.version}.zip`);
mkdirSync(distDir, { recursive: true });
rmSync(zipPath, { force: true });

execFileSync('zip', ['-r', '-q', zipPath, '.', '-x', '.*', '*/.*'], {
    cwd: resolve(root, 'src'),
    stdio: 'inherit',
});
console.log(`Built ${zipPath}`);
