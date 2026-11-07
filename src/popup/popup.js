/**
 * TabTrack popup UI. Storage reads/writes go through lib/storage.js;
 * anything that touches windows is delegated to the background worker.
 */
import { MAX_NAME_LENGTH, STORAGE_KEYS } from '../lib/constants.js';
import { pluralize } from '../lib/format.js';
import { matchesQuery, mergeImportedSessions, parseSessionsFile } from '../lib/sessions.js';
import * as storage from '../lib/storage.js';
import { isRestorableUrl } from '../lib/urls.js';

const STATUS_TIMEOUT_MS = 3000;
const CONFIRM_TIMEOUT_MS = 3000;

const elements = {};

/** Ids of sessions whose tab list is expanded; survives re-renders. */
const expandedSessionIds = new Set();

const dateFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
});

init();

function init() {
    const byId = (id) => document.getElementById(id);
    Object.assign(elements, {
        sessionName: byId('sessionName'),
        saveButton: byId('saveSession'),
        sessionsList: byId('sessionsList'),
        importButton: byId('importButton'),
        importFile: byId('importFile'),
        exportButton: byId('exportButton'),
        status: byId('status'),
        searchInput: byId('searchInput'),
        sessionCount: byId('sessionCount'),
        recoveryBanner: byId('recoveryBanner'),
        lazyRestore: byId('lazyRestore'),
        shortcutHint: byId('shortcutHint'),
    });

    setupEventListeners();
    renderSessions();
    renderRecoveryBanner();
    loadSettings();
    renderShortcutHint();
}

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
        storage.saveSettings({ lazyRestore: elements.lazyRestore.checked })
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sends a request to the background service worker. Resolves with the
 * handler's data or throws an Error whose message is safe to show the user.
 */
async function sendToBackground(type, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (!response?.ok) throw new Error(response?.error || 'Something went wrong.');
    return response.data;
}

async function getCurrentWindowId() {
    return (await chrome.windows.getCurrent()).id;
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

/** Runs an action; on failure logs it and shows the error message. */
async function withErrorStatus(label, action) {
    try {
        await action();
    } catch (error) {
        console.error(`${label} failed:`, error);
        showStatus(error.message || `${label} failed.`, 'error');
    }
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

    await withErrorStatus('Save session', async () => {
        const { session, skipped } = await sendToBackground('SAVE_WINDOW', {
            windowId: await getCurrentWindowId(),
            name: name.slice(0, MAX_NAME_LENGTH),
        });
        elements.sessionName.value = '';
        const count = pluralize(session.tabs.length, 'tab');
        showStatus(skipped > 0 ? `Saved ${count} (${skipped} browser pages skipped).` : `Saved ${count}.`);
        renderSessions();
    });
}

/**
 * Restoring runs in the background worker: focusing the new window closes
 * this popup, which would otherwise cut the restore short.
 */
function restoreSession(session) {
    return withErrorStatus('Restore session', () =>
        sendToBackground('RESTORE_SESSION', { sessionId: session.id })
    );
}

function restoreRecovery() {
    return withErrorStatus('Restore previous session', () => sendToBackground('RESTORE_RECOVERY'));
}

async function dismissRecovery() {
    await chrome.storage.local.remove(STORAGE_KEYS.recovery);
    renderRecoveryBanner();
}

function deleteSession(id) {
    return withErrorStatus('Delete session', async () => {
        await storage.deleteSession(id);
        showStatus('Session deleted.');
        renderSessions();
    });
}

async function renameSession(id, newName) {
    const name = newName.trim().slice(0, MAX_NAME_LENGTH);
    if (!name) {
        showStatus('Session name cannot be empty.', 'error');
        renderSessions();
        return;
    }
    await withErrorStatus('Rename session', async () => {
        await storage.updateSession(id, { name });
        showStatus('Session renamed.');
    });
    renderSessions();
}

/** Replaces a session's tabs with the tabs of the current window. */
function overwriteSessionTabs(id) {
    return withErrorStatus('Update session', async () => {
        const { tabs, groups } = await sendToBackground('CAPTURE_WINDOW', {
            windowId: await getCurrentWindowId(),
        });
        if (tabs.length === 0) {
            showStatus('No saveable tabs in this window.', 'error');
            return;
        }
        await storage.updateSession(id, { tabs, groups, updatedAt: new Date().toISOString() });
        showStatus(`Session updated with ${pluralize(tabs.length, 'tab')}.`);
        renderSessions();
    });
}

async function openTab(url) {
    if (isRestorableUrl(url)) await chrome.tabs.create({ url });
}

async function exportSessions() {
    const sessions = await storage.getSessions();
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

async function handleImport(event) {
    const file = event.target.files[0];
    event.target.value = ''; // allow re-importing the same file
    if (!file) return;

    await withErrorStatus('Import sessions', async () => {
        const imported = parseSessionsFile(await file.text());
        const { sessions, added, skipped } = mergeImportedSessions(await storage.getSessions(), imported);
        await storage.setSessions(sessions);
        renderSessions();

        if (added === 0) {
            showStatus('No new sessions found in file.', 'error');
        } else {
            const summary = `Imported ${pluralize(added, 'session')}`;
            showStatus(skipped > 0 ? `${summary} (${skipped} skipped).` : `${summary}.`);
        }
    });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

async function renderSessions() {
    const sessions = await storage.getSessions();
    const query = elements.searchInput.value;
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
    const { [STORAGE_KEYS.recovery]: recovery } = await chrome.storage.local.get(STORAGE_KEYS.recovery);
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
    const { lazyRestore } = await storage.getSettings();
    elements.lazyRestore.checked = lazyRestore;
}

async function renderShortcutHint() {
    const commands = await chrome.commands.getAll();
    const quickSave = commands.find((command) => command.name === 'quick-save');
    elements.shortcutHint.textContent = quickSave?.shortcut
        ? `Tip: press ${quickSave.shortcut} to quick-save this window.`
        : '';
}
