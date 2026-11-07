/**
 * TabTrack service worker.
 *
 * Owns everything that must outlive the popup: capturing and restoring
 * windows (restoring focuses a new window, which closes the popup), the
 * keyboard shortcut, and periodic auto-save for crash recovery.
 */
import { SCHEMA_VERSION, STORAGE_KEYS } from './lib/constants.js';
import { UserFacingError } from './lib/errors.js';
import { migrateSessions } from './lib/sessions.js';
import { addSession, findSession, getSettings, setSessions } from './lib/storage.js';
import { captureWindow, restoreWindow } from './lib/tabs.js';

const AUTOSAVE_ALARM = 'autosave';
const AUTOSAVE_SOON_ALARM = 'autosave-soon';
const AUTOSAVE_PERIOD_MINUTES = 5;
const AUTOSAVE_DEBOUNCE_MINUTES = 0.5; // Chrome's minimum alarm delay

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
    const { [STORAGE_KEYS.autosave]: autosave } = await chrome.storage.local.get(STORAGE_KEYS.autosave);
    if (autosave) {
        await chrome.storage.local.set({ [STORAGE_KEYS.recovery]: autosave });
        await chrome.storage.local.remove(STORAGE_KEYS.autosave);
    }
    scheduleAutosave();
});

async function migrateStorage() {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.sessions, STORAGE_KEYS.schemaVersion]);
    const sessions = stored[STORAGE_KEYS.sessions];
    const schemaVersion = stored[STORAGE_KEYS.schemaVersion] ?? 1;

    if (schemaVersion >= SCHEMA_VERSION && Array.isArray(sessions)) return;

    await setSessions(migrateSessions(sessions));
    await chrome.storage.local.set({ [STORAGE_KEYS.schemaVersion]: SCHEMA_VERSION });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

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

    await addSession(session);
    return { session, skipped };
}

async function restoreSessionById(sessionId) {
    const session = await findSession(sessionId);
    if (!session) throw new UserFacingError('Session not found.');
    const { lazyRestore } = await getSettings();
    await restoreWindow(session, { lazy: lazyRestore });
}

async function restoreRecovery() {
    const { [STORAGE_KEYS.recovery]: recovery } = await chrome.storage.local.get(STORAGE_KEYS.recovery);
    if (!recovery) throw new UserFacingError('Nothing to recover.');
    const { lazyRestore } = await getSettings();
    await chrome.storage.local.remove(STORAGE_KEYS.recovery);
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
        [STORAGE_KEYS.autosave]: { timestamp: new Date().toISOString(), windows: snapshots },
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
        await saveWindowAsSession(windowId, `Quick save · ${new Date().toLocaleString()}`);
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
