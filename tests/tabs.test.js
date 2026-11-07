import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureWindow, discardWhenUrlCommitted, restoreWindow } from '../src/lib/tabs.js';
import { installChromeMock } from './helpers/chrome-mock.js';

describe('captureWindow', () => {
    let chrome;
    beforeEach(() => {
        chrome = installChromeMock();
        chrome.tabs.query.mockResolvedValue([
            { url: 'https://a.com', title: 'A', pinned: true, groupId: -1 },
            { url: 'chrome://settings', title: 'Settings', groupId: -1 },
            { url: 'https://b.com', title: 'B', groupId: 555 },
            { url: 'https://c.com', title: '', groupId: 555 },
            { url: 'https://d.com', title: 'D', groupId: 777 },
        ]);
        chrome.tabGroups.get.mockImplementation(async (id) => ({
            id,
            title: id === 555 ? 'Work' : 'Fun',
            color: id === 555 ? 'blue' : 'red',
            collapsed: id === 777,
        }));
    });

    it('captures restorable tabs with pinned state and remapped group ids', async () => {
        const result = await captureWindow(1);

        expect(chrome.tabs.query).toHaveBeenCalledWith({ windowId: 1 });
        expect(result.skipped).toBe(1);
        expect(result.tabs).toEqual([
            { url: 'https://a.com', title: 'A', pinned: true },
            { url: 'https://b.com', title: 'B', groupId: 0 },
            { url: 'https://c.com', title: 'https://c.com', groupId: 0 },
            { url: 'https://d.com', title: 'D', groupId: 1 },
        ]);
        expect(result.groups).toEqual([
            { id: 0, title: 'Work', color: 'blue', collapsed: false },
            { id: 1, title: 'Fun', color: 'red', collapsed: true },
        ]);
    });

    it('ignores groups that cannot be read', async () => {
        chrome.tabGroups.get.mockRejectedValue(new Error('gone'));
        const result = await captureWindow(1);
        expect(result.groups).toEqual([]);
        expect(result.tabs.every((tab) => !('groupId' in tab))).toBe(true);
    });
});

describe('restoreWindow', () => {
    let chrome;
    beforeEach(() => {
        chrome = installChromeMock();
    });

    const snapshot = {
        tabs: [
            { url: 'https://a.com', pinned: true },
            { url: 'chrome://settings' },
            { url: 'https://b.com', groupId: 0 },
            { url: 'https://c.com', groupId: 0 },
        ],
        groups: [{ id: 0, title: 'Work', color: 'blue', collapsed: true }],
    };

    it('opens all restorable tabs in one new window', async () => {
        await restoreWindow(snapshot);
        expect(chrome.windows.create).toHaveBeenCalledTimes(1);
        expect(chrome.windows.create).toHaveBeenCalledWith({
            url: ['https://a.com', 'https://b.com', 'https://c.com'],
            focused: true,
        });
    });

    it('restores pinned tabs and tab groups', async () => {
        await restoreWindow(snapshot);
        expect(chrome.tabs.update).toHaveBeenCalledWith(10, { pinned: true });
        expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [11, 12], createProperties: { windowId: 1 } });
        expect(chrome.tabGroups.update).toHaveBeenCalledWith(100, {
            title: 'Work',
            color: 'blue',
            collapsed: true,
        });
    });

    it('does nothing when no tab is restorable', async () => {
        await restoreWindow({ tabs: [{ url: 'about:blank' }] });
        expect(chrome.windows.create).not.toHaveBeenCalled();
    });

    it('keeps going if a group cannot be restored', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        chrome.tabs.group.mockRejectedValue(new Error('nope'));
        await expect(restoreWindow(snapshot)).resolves.toBe(1);
    });

    it('lazily discards every tab except the first', async () => {
        await restoreWindow(snapshot, { lazy: true });
        await vi.waitFor(() => expect(chrome.tabs.discard).toHaveBeenCalledTimes(2));
        expect(chrome.tabs.discard).toHaveBeenCalledWith(11);
        expect(chrome.tabs.discard).toHaveBeenCalledWith(12);
    });
});

describe('discardWhenUrlCommitted', () => {
    let chrome;
    beforeEach(() => {
        chrome = installChromeMock();
    });

    it('waits for the URL to commit before discarding', async () => {
        chrome.tabs.get
            .mockResolvedValueOnce({ id: 5, url: '', pendingUrl: 'https://a.com' })
            .mockResolvedValue({ id: 5, url: 'https://a.com', active: false });

        const result = discardWhenUrlCommitted(5, 1000);
        await vi.waitFor(() => expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled());
        expect(chrome.tabs.discard).not.toHaveBeenCalled();

        chrome.tabs.onUpdated._emit(5, { url: 'https://a.com' }, { id: 5, url: 'https://a.com' });
        await expect(result).resolves.toBe(true);
        expect(chrome.tabs.discard).toHaveBeenCalledWith(5);
    });

    it('gives up after the timeout without discarding', async () => {
        chrome.tabs.get.mockResolvedValue({ id: 5, url: '', pendingUrl: 'https://a.com' });
        await expect(discardWhenUrlCommitted(5, 10)).resolves.toBe(false);
        expect(chrome.tabs.discard).not.toHaveBeenCalled();
    });

    it('never discards the active tab', async () => {
        chrome.tabs.get.mockResolvedValue({ id: 5, url: 'https://a.com', active: true });
        await expect(discardWhenUrlCommitted(5, 1000)).resolves.toBe(false);
        expect(chrome.tabs.discard).not.toHaveBeenCalled();
    });
});
