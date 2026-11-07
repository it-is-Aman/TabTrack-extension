import { beforeEach, describe, expect, it } from 'vitest';
import * as storage from '../src/lib/storage.js';
import { installChromeMock } from './helpers/chrome-mock.js';

const session = (id, name = id) => ({ id, name, timestamp: '2026-01-01T00:00:00.000Z', tabs: [] });

describe('storage', () => {
    let chrome;
    beforeEach(() => {
        chrome = installChromeMock({ storage: { sessions: [session('a')] } });
    });

    it('returns an empty list when nothing is stored', async () => {
        installChromeMock();
        expect(await storage.getSessions()).toEqual([]);
    });

    it('adds new sessions at the top', async () => {
        await storage.addSession(session('b'));
        expect((await storage.getSessions()).map((s) => s.id)).toEqual(['b', 'a']);
    });

    it('updates a session by id', async () => {
        await storage.updateSession('a', { name: 'Renamed' });
        expect((await storage.findSession('a')).name).toBe('Renamed');
    });

    it('throws when updating a missing session', async () => {
        await expect(storage.updateSession('missing', {})).rejects.toThrow('not found');
    });

    it('deletes a session by id', async () => {
        await storage.deleteSession('a');
        expect(chrome.storage.local._dump().sessions).toEqual([]);
    });

    it('merges settings with defaults', async () => {
        expect(await storage.getSettings()).toEqual({ lazyRestore: true });
        await storage.saveSettings({ lazyRestore: false });
        expect(await storage.getSettings()).toEqual({ lazyRestore: false });
    });
});
