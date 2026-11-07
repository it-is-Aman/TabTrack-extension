'use strict';

/** URL schemes Chrome allows an extension to reopen. */
const RESTORABLE_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_NAME_LENGTH = 100;
const STATUS_TIMEOUT_MS = 3000;
const CONFIRM_TIMEOUT_MS = 3000;
const TAB_GROUP_COLORS = new Set([
    'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange',
]);
const DEFAULT_SETTINGS = { lazyRestore: true };

const elements = {};

/** Ids of sessions whose tab list is expanded; survives re-renders. */
const expandedSessionIds = new Set();

const dateFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
});

document.addEventListener('DOMContentLoaded', () => {
    elements.sessionName = document.getElementById('sessionName');
    elements.saveButton = document.getElementById('saveSession');
    elements.sessionsList = document.getElementById('sessionsList');
    elements.importButton = document.getElementById('importButton');
    elements.importFile = document.getElementById('importFile');
    elements.exportButton = document.getElementById('exportButton');
    elements.status = document.getElementById('status');
    elements.searchInput = document.getElementById('searchInput');
    elements.sessionCount = document.getElementById('sessionCount');
    elements.recoveryBanner = document.getElementById('recoveryBanner');
    elements.lazyRestore = document.getElementById('lazyRestore');
    elements.shortcutHint = document.getElementById('shortcutHint');

    setupEventListeners();
    renderSessions();
    renderRecoveryBanner();
    loadSettings();
    renderShortcutHint();
});

function setupEventListeners() {
    elements.saveButton.addEventListener('click', saveCurrentSession);
    elements.sessionName.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') saveCurrentSession();
    });
    elements.importButton.addEventListener('click', () => elements.importFile.click());
    elements.importFile.addEventListener('change', handleImport);
    elements.exportButton.addEventListener('click', exportSessions);
    elements.searchInput.addEventListener('input', renderSessions);
    elements.lazyRestore.addEventListener('change', () =>
        saveSettings({ lazyRestore: elements.lazyRestore.checked })
    );
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function getSessions() {
    const { sessions } = await chrome.storage.local.get('sessions');
    return Array.isArray(sessions) ? sessions : [];
}

async function setSessions(sessions) {
    await chrome.storage.local.set({ sessions });
}

async function getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return { ...DEFAULT_SETTINGS, ...settings };
}

async function saveSettings(changes) {
    const settings = await getSettings();
    await chrome.storage.local.set({ settings: { ...settings, ...changes } });
}

/** Applies `changes` to the session with the given id and persists it. */
async function updateSession(id, changes) {
    const sessions = await getSessions();
    const session = sessions.find((s) => s.id === id);
    if (!session) throw new Error(`Session ${id} not found`);
    Object.assign(session, changes);
    await setSessions(sessions);
}

// ---------------------------------------------------------------------------
// Helpers
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
 * Sends a request to the background service worker, which owns capturing
 * and restoring windows. Resolves with the handler's data or throws an Error
 * whose message is safe to show to the user.
 */
async function sendToBackground(type, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (!response?.ok) throw new Error(response?.error || 'Something went wrong.');
    return response.data;
}

async function getCurrentWindowId() {
    return (await chrome.windows.getCurrent()).id;
}

function pluralize(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function byNewestFirst(a, b) {
    return Date.parse(b.timestamp) - Date.parse(a.timestamp);
}

function showStatus(message, type = 'success') {
    elements.status.textContent = message;
    elements.status.className = `status status--${type}`;
    clearTimeout(showStatus.timer);
    showStatus.timer = setTimeout(() => {
        elements.status.textContent = '';
        elements.status.className = 'status';
    }, STATUS_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function saveCurrentSession() {
    const name = elements.sessionName.value.trim();
    if (!name) {
        showStatus('Please enter a session name.', 'error');
        elements.sessionName.focus();
        return;
    }

    try {
        const { session, skipped } = await sendToBackground('SAVE_WINDOW', {
            windowId: await getCurrentWindowId(),
            name: name.slice(0, MAX_NAME_LENGTH),
        });

        elements.sessionName.value = '';
        const count = pluralize(session.tabs.length, 'tab');
        showStatus(skipped > 0 ? `Saved ${count} (${skipped} browser pages skipped).` : `Saved ${count}.`);
        renderSessions();
    } catch (error) {
        console.error('Failed to save session:', error);
        showStatus(error.message, 'error');
    }
}

/**
 * Restoring runs in the background worker: focusing the new window closes
 * this popup, which would otherwise cut the restore short.
 */
async function restoreSession(session) {
    try {
        await sendToBackground('RESTORE_SESSION', { sessionId: session.id });
    } catch (error) {
        console.error('Failed to restore session:', error);
        showStatus(error.message, 'error');
    }
}

async function restoreRecovery() {
    try {
        await sendToBackground('RESTORE_RECOVERY');
    } catch (error) {
        console.error('Failed to restore previous browser session:', error);
        showStatus(error.message, 'error');
    }
}

async function dismissRecovery() {
    await chrome.storage.local.remove('recovery');
    renderRecoveryBanner();
}

async function deleteSession(id) {
    try {
        const sessions = await getSessions();
        await setSessions(sessions.filter((session) => session.id !== id));
        showStatus('Session deleted.');
        renderSessions();
    } catch (error) {
        console.error('Failed to delete session:', error);
        showStatus('Could not delete session.', 'error');
    }
}

async function renameSession(id, newName) {
    const name = newName.trim().slice(0, MAX_NAME_LENGTH);
    if (!name) {
        showStatus('Session name cannot be empty.', 'error');
        return;
    }
    try {
        await updateSession(id, { name });
        showStatus('Session renamed.');
    } catch (error) {
        console.error('Failed to rename session:', error);
        showStatus('Could not rename session.', 'error');
    }
    renderSessions();
}

/** Replaces a session's tabs with the tabs of the current window. */
async function overwriteSessionTabs(id) {
    try {
        const { tabs, groups } = await sendToBackground('CAPTURE_WINDOW', {
            windowId: await getCurrentWindowId(),
        });
        if (tabs.length === 0) {
            showStatus('No saveable tabs in this window.', 'error');
            return;
        }
        await updateSession(id, { tabs, groups, updatedAt: new Date().toISOString() });
        showStatus(`Session updated with ${pluralize(tabs.length, 'tab')}.`);
        renderSessions();
    } catch (error) {
        console.error('Failed to update session:', error);
        showStatus('Could not update session.', 'error');
    }
}

async function openTab(url) {
    if (!isRestorableUrl(url)) return;
    await chrome.tabs.create({ url });
}

async function exportSessions() {
    const sessions = await getSessions();
    if (sessions.length === 0) {
        showStatus('No sessions to export.', 'error');
        return;
    }

    const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tabtrack_sessions_${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    // Give the browser a moment to start the download before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Validates one imported session and returns a clean copy, or null if the
 * entry is unusable. Only http(s) URLs are kept.
 */
function sanitizeSession(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.name !== 'string' || !raw.name.trim()) return null;
    if (!Array.isArray(raw.tabs)) return null;

    const groups = (Array.isArray(raw.groups) ? raw.groups : [])
        .filter((group) => group && Number.isInteger(group.id) && TAB_GROUP_COLORS.has(group.color))
        .map((group) => ({
            id: group.id,
            title: typeof group.title === 'string' ? group.title : '',
            color: group.color,
            collapsed: Boolean(group.collapsed),
        }));
    const groupIds = new Set(groups.map((group) => group.id));

    const tabs = raw.tabs
        .filter((tab) => tab && isRestorableUrl(tab.url))
        .map((tab) => {
            const clean = {
                url: tab.url,
                title: typeof tab.title === 'string' ? tab.title : tab.url,
            };
            if (tab.pinned === true) clean.pinned = true;
            if (groupIds.has(tab.groupId)) clean.groupId = tab.groupId;
            return clean;
        });
    if (tabs.length === 0) return null;

    const timestamp = Number.isNaN(Date.parse(raw.timestamp))
        ? new Date().toISOString()
        : new Date(raw.timestamp).toISOString();

    const session = {
        id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
        name: raw.name.trim().slice(0, MAX_NAME_LENGTH),
        timestamp,
        tabs,
    };
    const usedGroups = groups.filter((group) => tabs.some((tab) => tab.groupId === group.id));
    if (usedGroups.length > 0) session.groups = usedGroups;
    return session;
}

function sessionKey(session) {
    return `${session.name}|${session.timestamp}`;
}

async function handleImport(event) {
    const file = event.target.files[0];
    event.target.value = ''; // allow re-importing the same file
    if (!file) return;

    let parsed;
    try {
        parsed = JSON.parse(await file.text());
    } catch {
        showStatus('Invalid file: not valid JSON.', 'error');
        return;
    }

    if (!Array.isArray(parsed)) {
        showStatus('Invalid file: expected a list of sessions.', 'error');
        return;
    }

    try {
        const current = await getSessions();
        const knownIds = new Set(current.map((s) => s.id));
        const knownKeys = new Set(current.map(sessionKey));

        let added = 0;
        let skipped = 0;
        for (const raw of parsed) {
            const session = sanitizeSession(raw);
            if (!session || knownKeys.has(sessionKey(session))) {
                skipped++;
                continue;
            }
            if (knownIds.has(session.id)) session.id = crypto.randomUUID();

            knownIds.add(session.id);
            knownKeys.add(sessionKey(session));
            current.push(session);
            added++;
        }

        current.sort(byNewestFirst);
        await setSessions(current);
        renderSessions();

        if (added === 0) {
            showStatus('No new sessions found in file.', 'error');
        } else {
            showStatus(
                skipped > 0
                    ? `Imported ${added} sessions (${skipped} skipped).`
                    : `Imported ${added} sessions.`
            );
        }
    } catch (error) {
        console.error('Failed to import sessions:', error);
        showStatus('Could not import sessions.', 'error');
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function matchesQuery(session, query) {
    if (!query) return true;
    const haystack = [
        session.name,
        ...session.tabs.flatMap((tab) => [tab.title, tab.url]),
    ];
    return haystack.some((text) => String(text).toLowerCase().includes(query));
}

async function renderSessions() {
    const sessions = await getSessions();
    const query = elements.searchInput.value.trim().toLowerCase();
    const visible = sessions.filter((session) => matchesQuery(session, query));

    elements.sessionCount.textContent = sessions.length ? `(${sessions.length})` : '';
    elements.searchInput.hidden = sessions.length === 0;
    elements.sessionsList.replaceChildren();

    if (visible.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-state';
        empty.textContent = sessions.length === 0
            ? 'No saved sessions yet.'
            : 'No sessions match your search.';
        elements.sessionsList.appendChild(empty);
        return;
    }

    for (const session of visible) {
        elements.sessionsList.appendChild(createSessionElement(session));
    }
}

function createButton(label, className, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (className) button.className = className;
    button.addEventListener('click', onClick);
    return button;
}

function createSessionElement(session) {
    const isExpanded = expandedSessionIds.has(session.id);

    const item = document.createElement('div');
    item.className = 'session-item';

    // Header row: toggle + name/meta + restore
    const header = document.createElement('div');
    header.className = 'session-header';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'session-toggle';
    toggle.setAttribute('aria-expanded', String(isExpanded));
    toggle.setAttribute('aria-label', `${isExpanded ? 'Hide' : 'Show'} tabs in ${session.name}`);
    toggle.textContent = isExpanded ? '▾' : '▸';
    toggle.addEventListener('click', () => {
        if (isExpanded) expandedSessionIds.delete(session.id);
        else expandedSessionIds.add(session.id);
        renderSessions();
    });

    const info = document.createElement('div');
    info.className = 'session-info';

    const name = document.createElement('span');
    name.className = 'session-name';
    name.textContent = session.name;
    name.title = 'Double-click to rename';
    name.addEventListener('dblclick', () => startRename(info, name, session));

    const meta = document.createElement('span');
    meta.className = 'session-meta';
    const savedAt = session.updatedAt || session.timestamp;
    const metaParts = [pluralize(session.tabs.length, 'tab')];
    if (session.groups?.length) metaParts.push(pluralize(session.groups.length, 'group'));
    metaParts.push(dateFormatter.format(new Date(savedAt)));
    meta.textContent = metaParts.join(' · ');

    info.append(name, meta);

    const restoreButton = createButton('Restore', '', () => restoreSession(session));

    header.append(toggle, info, restoreButton);
    item.appendChild(header);

    if (isExpanded) {
        item.appendChild(createSessionDetails(session, info, name));
    }
    return item;
}

function createSessionDetails(session, info, nameElement) {
    const details = document.createElement('div');
    details.className = 'session-details';

    const tabList = document.createElement('ul');
    tabList.className = 'tab-list';
    const groupsById = new Map((session.groups || []).map((group) => [group.id, group]));
    for (const tab of session.tabs) {
        const li = document.createElement('li');

        const group = groupsById.get(tab.groupId);
        if (group) {
            const dot = document.createElement('span');
            dot.className = `group-dot group-dot--${group.color}`;
            dot.title = group.title ? `Group: ${group.title}` : 'Tab group';
            li.appendChild(dot);
        }
        if (tab.pinned) {
            const pin = document.createElement('span');
            pin.className = 'pin-icon';
            pin.textContent = '📌';
            pin.title = 'Pinned tab';
            li.appendChild(pin);
        }

        const link = document.createElement('a');
        link.href = tab.url;
        link.textContent = tab.title || tab.url;
        link.title = tab.url;
        link.addEventListener('click', (event) => {
            event.preventDefault();
            openTab(tab.url);
        });
        li.appendChild(link);
        tabList.appendChild(li);
    }

    const toolbar = document.createElement('div');
    toolbar.className = 'session-toolbar';

    const renameButton = createButton('Rename', 'secondary-btn', () =>
        startRename(info, nameElement, session)
    );
    const updateButton = createButton('Update with current tabs', 'secondary-btn', (event) =>
        confirmClick(event.currentTarget, 'Replace tabs?', () => overwriteSessionTabs(session.id))
    );
    const deleteButton = createButton('Delete', 'delete-btn', (event) =>
        confirmClick(event.currentTarget, 'Confirm?', () => deleteSession(session.id))
    );

    toolbar.append(renameButton, updateButton, deleteButton);
    details.append(tabList, toolbar);
    return details;
}

/** Swaps the session name for an inline text field. Enter saves, Escape cancels. */
function startRename(info, nameElement, session) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-input';
    input.value = session.name;
    input.maxLength = MAX_NAME_LENGTH;
    input.setAttribute('aria-label', 'New session name');

    let finished = false;
    const finish = (save) => {
        if (finished) return;
        finished = true;
        if (save && input.value.trim() !== session.name) renameSession(session.id, input.value);
        else renderSessions();
    };

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') finish(true);
        if (event.key === 'Escape') {
            event.preventDefault(); // keep the popup open
            finish(false);
        }
    });
    input.addEventListener('blur', () => finish(true));

    info.replaceChild(input, nameElement);
    input.focus();
    input.select();
}

/**
 * Two-step confirmation for destructive actions: the first click arms the
 * button and changes its label; a second click within the timeout runs it.
 */
function confirmClick(button, armedLabel, action) {
    if (button.dataset.armed === 'true') {
        clearTimeout(Number(button.dataset.timer));
        action();
        return;
    }

    const originalLabel = button.textContent;
    button.dataset.armed = 'true';
    button.textContent = armedLabel;
    button.dataset.timer = String(
        setTimeout(() => {
            button.dataset.armed = 'false';
            button.textContent = originalLabel;
        }, CONFIRM_TIMEOUT_MS)
    );
}

// ---------------------------------------------------------------------------
// Recovery banner, settings, shortcut hint
// ---------------------------------------------------------------------------

async function renderRecoveryBanner() {
    const { recovery } = await chrome.storage.local.get('recovery');
    const banner = elements.recoveryBanner;
    banner.replaceChildren();
    banner.hidden = !recovery?.windows?.length;
    if (banner.hidden) return;

    const tabCount = recovery.windows.reduce((sum, win) => sum + win.tabs.length, 0);
    const text = document.createElement('p');
    text.textContent =
        `Previous browser session: ${pluralize(recovery.windows.length, 'window')}, ` +
        `${pluralize(tabCount, 'tab')} (${dateFormatter.format(new Date(recovery.timestamp))}).`;

    const actions = document.createElement('div');
    actions.className = 'recovery-actions';
    actions.append(
        createButton('Restore', '', restoreRecovery),
        createButton('Dismiss', 'secondary-btn', dismissRecovery)
    );
    banner.append(text, actions);
}

async function loadSettings() {
    const { lazyRestore } = await getSettings();
    elements.lazyRestore.checked = lazyRestore;
}

async function renderShortcutHint() {
    const commands = await chrome.commands.getAll();
    const quickSave = commands.find((command) => command.name === 'quick-save');
    elements.shortcutHint.textContent = quickSave?.shortcut
        ? `Tip: press ${quickSave.shortcut} to quick-save this window.`
        : '';
}
