import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../src/manifest.json', import.meta.url)));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const srcPath = (path) => new URL(`../src/${path}`, import.meta.url);

describe('manifest.json', () => {
    it('uses Manifest V3', () => {
        expect(manifest.manifest_version).toBe(3);
    });

    it('has the same version as package.json', () => {
        expect(manifest.version).toBe(pkg.version);
    });

    it('requests only the permissions the extension uses', () => {
        expect(manifest.permissions.sort()).toEqual(['alarms', 'storage', 'tabGroups', 'tabs']);
        expect(manifest.host_permissions).toBeUndefined();
    });

    it('references files that exist', () => {
        const files = [
            manifest.background.service_worker,
            manifest.action.default_popup,
            ...Object.values(manifest.icons),
            ...Object.values(manifest.action.default_icon),
        ];
        for (const file of files) {
            expect(existsSync(srcPath(file)), file).toBe(true);
        }
    });
});
