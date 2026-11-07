/**
 * Capturing and restoring browser windows via the chrome.tabs and
 * chrome.tabGroups APIs. Used by the service worker only.
 */
import { isRestorableUrl } from './urls.js';

const DISCARD_WAIT_MS = 15000;

/**
 * Captures the restorable tabs of a window together with pinned state and
 * tab groups. Group ids are rewritten to small local indexes because Chrome's
 * group ids are only valid for the current browser session.
 *
 * @returns {Promise<{tabs: object[], groups: object[], skipped: number}>}
 */
export async function captureWindow(windowId) {
    const tabs = await chrome.tabs.query({ windowId });
    const restorable = tabs.filter((tab) => isRestorableUrl(tab.url));

    const chromeGroupIds = [
        ...new Set(
            restorable
                .map((tab) => tab.groupId)
                .filter((id) => id !== undefined && id !== chrome.tabGroups.TAB_GROUP_ID_NONE)
        ),
    ];
    const chromeGroups = await Promise.all(
        chromeGroupIds.map((id) => chrome.tabGroups.get(id).catch(() => null))
    );

    const localIdByChromeId = new Map();
    const groups = [];
    for (const group of chromeGroups) {
        if (!group) continue;
        localIdByChromeId.set(group.id, groups.length);
        groups.push({
            id: groups.length,
            title: group.title || '',
            color: group.color,
            collapsed: Boolean(group.collapsed),
        });
    }

    return {
        tabs: restorable.map((tab) => {
            const saved = { url: tab.url, title: tab.title || tab.url };
            if (tab.pinned) saved.pinned = true;
            if (localIdByChromeId.has(tab.groupId)) {
                saved.groupId = localIdByChromeId.get(tab.groupId);
            }
            return saved;
        }),
        groups,
        skipped: tabs.length - restorable.length,
    };
}

/**
 * Opens a saved window snapshot ({tabs, groups}) in a new browser window,
 * restoring pinned tabs and tab groups. With `lazy`, every tab except the
 * first is discarded so it loads only when the user switches to it.
 *
 * @returns {Promise<number|undefined>} the new window's id
 */
export async function restoreWindow(snapshot, { lazy = false } = {}) {
    const tabs = (snapshot.tabs || []).filter((tab) => isRestorableUrl(tab.url));
    if (tabs.length === 0) return undefined;

    const window = await chrome.windows.create({
        url: tabs.map((tab) => tab.url),
        focused: true,
    });
    const createdTabs = window.tabs || [];

    await Promise.all(
        tabs.map((tab, i) =>
            tab.pinned && createdTabs[i]
                ? chrome.tabs.update(createdTabs[i].id, { pinned: true })
                : null
        )
    );

    for (const group of snapshot.groups || []) {
        const tabIds = tabs
            .map((tab, i) => (tab.groupId === group.id ? createdTabs[i]?.id : undefined))
            .filter((id) => id !== undefined);
        if (tabIds.length === 0) continue;

        try {
            const newGroupId = await chrome.tabs.group({
                tabIds,
                createProperties: { windowId: window.id },
            });
            await chrome.tabGroups.update(newGroupId, {
                title: group.title,
                color: group.color,
                collapsed: Boolean(group.collapsed),
            });
        } catch (error) {
            console.warn('Could not restore tab group:', error);
        }
    }

    if (lazy) {
        createdTabs.slice(1).forEach((tab) => discardWhenUrlCommitted(tab.id));
    }
    return window.id;
}

/**
 * Discards a background tab once its URL has committed. Discarding earlier
 * would lose the URL, so we wait for Chrome to report it first.
 */
export async function discardWhenUrlCommitted(tabId, timeoutMs = DISCARD_WAIT_MS) {
    const committed = await waitForCommittedUrl(tabId, timeoutMs);
    if (!committed) return false;
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.active || tab.discarded) return false;
        await chrome.tabs.discard(tabId);
        return true;
    } catch {
        return false; // tab closed or not discardable; it simply stays loaded
    }
}

function isCommitted(tab) {
    return Boolean(tab.url) && tab.url !== 'about:blank' && !tab.pendingUrl;
}

export function waitForCommittedUrl(tabId, timeoutMs) {
    return new Promise((resolve) => {
        const finish = (result) => {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve(result);
        };
        const onUpdated = (id, _changeInfo, tab) => {
            if (id === tabId && isCommitted(tab)) finish(true);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);

        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.get(tabId).then(
            (tab) => isCommitted(tab) && finish(true),
            () => finish(false)
        );
    });
}
