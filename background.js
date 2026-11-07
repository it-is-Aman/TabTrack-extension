'use strict';

/**
 * TabTrack service worker.
 *
 * Owns everything that must outlive the popup: capturing and restoring
 * windows (restoring focuses a new window, which closes the popup), the
 * keyboard shortcut, and periodic auto-save for crash recovery.
 *
 * Storage schema versions:
 *   1 - sessions stored oldest-first, no ids
 *   2 - every session has a unique `id`; sessions stored newest-first.
 *       Tabs may carry `pinned` and `groupId`; sessions may carry `groups`.
 */
const SCHEMA_VERSION = 2;

const RESTORABLE_PROTOCOLS = new Set(['http:', 'https:']);
const AUTOSAVE_ALARM = 'autosave';
const AUTOSAVE_SOON_ALARM = 'autosave-soon';
const AUTOSAVE_PERIOD_MINUTES = 5;
const AUTOSAVE_DEBOUNCE_MINUTES = 0.5; // Chrome's minimum alarm delay
const DISCARD_WAIT_MS = 15000;
const DEFAULT_SETTINGS = { lazyRestore: true };

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Runs on first install and on every extension update.
chrome.runtime.onInstalled.addListener(async () => {
    try {
        await migrateStorage();
    } catch (error) {
        console.error('TabTrack storage migration failed:', error);
    }
    scheduleAutosave();
});

// Runs when the browser profile starts. The last auto-save snapshot is what
// was open before the browser closed (or crashed), so keep it for recovery.
chrome.runtime.onStartup.addListener(async () => {
    const { autosave } = await chrome.storage.local.get('autosave');
    if (autosave) {
        await chrome.storage.local.set({ recovery: autosave });
        await chrome.storage.local.remove('autosave');
    }
    scheduleAutosave();
});

async function migrateStorage() {
    const { sessions, schemaVersion = 1 } = await chrome.storage.local.get([
        'sessions',
        'schemaVersion',
    ]);

    if (schemaVersion >= SCHEMA_VERSION && Array.isArray(sessions)) return;

    const migrated = (Array.isArray(sessions) ? sessions : [])
        .map((session) => ({
            ...session,
            id: session.id || crypto.randomUUID(),
        }))
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

    await chrome.storage.local.set({ sessions: migrated, schemaVersion: SCHEMA_VERSION });
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

function isRestorableUrl(url) {
    if (typeof url !== 'string') return false;
    try {
        return RESTORABLE_PROTOCOLS.has(new URL(url).protocol);
    } catch {
        return false;
    }
}

/**
 * Captures the restorable tabs of a window together with pinned state and
 * tab groups. Group ids are rewritten to small local indexes because Chrome's
 * group ids are only valid for the current browser session.
 *
 * @returns {Promise<{tabs: object[], groups: object[], skipped: number}>}
 */
async function captureWindow(windowId) {
    const tabs = await chrome.tabs.query({ windowId });
    const restorable = tabs.filter((tab) => isRestorableUrl(tab.url));

    const chromeGroupIds = [
        ...new Set(
            restorable
                .map((tab) => tab.groupId)
                .filter((id) => id !== chrome.tabGroups.TAB_GROUP_ID_NONE)
        ),
    ];
    const chromeGroups = await Promise.all(
        chromeGroupIds.map((id) => chrome.tabGroups.get(id).catch(() => null))
    );

    const localIdByChromeId = new Map();
    const groups = [];
    chromeGroups.forEach((group) => {
        if (!group) return;
        localIdByChromeId.set(group.id, groups.length);
        groups.push({
            id: groups.length,
            title: group.title || '',
            color: group.color,
            collapsed: group.collapsed,
        });
    });

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

async function saveWindowAsSession(windowId, name) {
    const { tabs, groups, skipped } = await captureWindow(windowId);
    if (tabs.length === 0) {
        throw new UserFacingError('No saveable tabs in this window.');
    }

    const session = {
        id: crypto.randomUUID(),
        name,
        timestamp: new Date().toISOString(),
        tabs,
    };
    if (groups.length > 0) session.groups = groups;

    const { sessions = [] } = await chrome.storage.local.get('sessions');
    sessions.unshift(session); // newest first
    await chrome.storage.local.set({ sessions });
    return { session, skipped };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Opens a saved window snapshot ({tabs, groups}) in a new browser window,
 * restoring pinned tabs and tab groups. With lazy restore, every tab except
 * the first is discarded so it loads only when the user switches to it.
 */
async function restoreWindow(snapshot, { lazy }) {
    const tabs = (snapshot.tabs || []).filter((tab) => isRestorableUrl(tab.url));
    if (tabs.length === 0) return;

    const window = await chrome.windows.create({
        url: tabs.map((tab) => tab.url),
        focused: true,
    });
    const createdTabs = window.tabs;

    // Pinned state
    await Promise.all(
        tabs.map((tab, i) =>
            tab.pinned && createdTabs[i]
                ? chrome.tabs.update(createdTabs[i].id, { pinned: true })
                : null
        )
    );

    // Tab groups
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
}

/**
 * Discards a background tab once its URL has committed. Discarding earlier
 * would lose the URL, so we wait for Chrome to report it first.
 */
async function discardWhenUrlCommitted(tabId) {
    const committed = await waitForCommittedUrl(tabId);
    if (!committed) return;
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.active && !tab.discarded) await chrome.tabs.discard(tabId);
    } catch {
        // Tab was closed or cannot be discarded; it simply stays loaded.
    }
}

function waitForCommittedUrl(tabId) {
    const isCommitted = (tab) =>
        Boolean(tab.url) && tab.url !== 'about:blank' && !tab.pendingUrl;

    return new Promise((resolve) => {
        const finish = (result) => {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve(result);
        };
        const onUpdated = (id, _changeInfo, tab) => {
            if (id === tabId && isCommitted(tab)) finish(true);
        };
        const timer = setTimeout(() => finish(false), DISCARD_WAIT_MS);

        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.get(tabId).then(
            (tab) => isCommitted(tab) && finish(true),
            () => finish(false)
        );
    });
}

async function getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return { ...DEFAULT_SETTINGS, ...settings };
}

async function restoreSessionById(sessionId) {
    const { sessions = [] } = await chrome.storage.local.get('sessions');
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) throw new UserFacingError('Session not found.');
    const { lazyRestore } = await getSettings();
    await restoreWindow(session, { lazy: lazyRestore });
}

async function restoreRecovery() {
    const { recovery } = await chrome.storage.local.get('recovery');
    if (!recovery) throw new UserFacingError('Nothing to recover.');
    const { lazyRestore } = await getSettings();
    await chrome.storage.local.remove('recovery');
    for (const windowSnapshot of recovery.windows) {
        await restoreWindow(windowSnapshot, { lazy: lazyRestore });
    }
}

// ---------------------------------------------------------------------------
// Auto-save
// ---------------------------------------------------------------------------

function scheduleAutosave() {
    chrome.alarms.create(AUTOSAVE_ALARM, { periodInMinutes: AUTOSAVE_PERIOD_MINUTES });
}

/** Re-creating the alarm resets it, which debounces bursts of tab activity. */
function scheduleAutosaveSoon() {
    chrome.alarms.create(AUTOSAVE_SOON_ALARM, { delayInMinutes: AUTOSAVE_DEBOUNCE_MINUTES });
}

async function autosave() {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const snapshots = [];
    for (const win of windows) {
        if (win.incognito) continue;
        const { tabs, groups } = await captureWindow(win.id);
        if (tabs.length > 0) snapshots.push({ tabs, groups });
    }

    // Never replace a useful snapshot with an empty one (e.g. all windows
    // closed on macOS while Chrome keeps running).
    if (snapshots.length === 0) return;

    await chrome.storage.local.set({
        autosave: { timestamp: new Date().toISOString(), windows: snapshots },
    });
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTOSAVE_ALARM || alarm.name === AUTOSAVE_SOON_ALARM) {
        autosave().catch((error) => console.error('Auto-save failed:', error));
    }
});

chrome.tabs.onCreated.addListener(scheduleAutosaveSoon);
chrome.tabs.onRemoved.addListener(scheduleAutosaveSoon);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.pinned !== undefined || changeInfo.groupId !== undefined) {
        scheduleAutosaveSoon();
    }
});

// ---------------------------------------------------------------------------
// Keyboard shortcut
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command !== 'quick-save') return;

    try {
        const windowId = tab?.windowId ?? (await chrome.windows.getLastFocused()).id;
        const name = `Quick save · ${new Date().toLocaleString()}`;
        await saveWindowAsSession(windowId, name);
        await flashBadge('✓', '#27ae60');
    } catch (error) {
        console.error('Quick save failed:', error);
        await flashBadge('!', '#c0392b');
    }
});

async function flashBadge(text, color) {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
}

// ---------------------------------------------------------------------------
// Messages from the popup
// ---------------------------------------------------------------------------

/** An error whose message is safe to show to the user as-is. */
class UserFacingError extends Error {}

const messageHandlers = {
    SAVE_WINDOW: ({ windowId, name }) => saveWindowAsSession(windowId, name),
    CAPTURE_WINDOW: ({ windowId }) => captureWindow(windowId),
    RESTORE_SESSION: ({ sessionId }) => restoreSessionById(sessionId),
    RESTORE_RECOVERY: () => restoreRecovery(),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    const handler = messageHandlers[message?.type];
    if (!handler) return false;

    handler(message)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => {
            console.error(`${message.type} failed:`, error);
            sendResponse({
                ok: false,
                error: error instanceof UserFacingError ? error.message : 'Something went wrong.',
            });
        });
    return true; // keep the channel open for the async response
});
