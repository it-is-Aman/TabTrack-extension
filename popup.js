document.addEventListener('DOMContentLoaded', () => {
    loadSessions();
    setupEventListeners();
});

function setupEventListeners() {
    document.getElementById('saveSession').addEventListener('click', saveCurrentSession);
    document.getElementById('importButton').addEventListener('click', () => {
        document.getElementById('importFile').click();
    });
    document.getElementById('importFile').addEventListener('change', handleImport);
    document.getElementById('exportButton').addEventListener('click', exportSessions);
}

async function saveCurrentSession() {
    const sessionName = document.getElementById('sessionName').value.trim();
    if (!sessionName) {
        alert('Please enter a session name');
        return;
    }

    const tabs = await chrome.tabs.query({ currentWindow: true });
    const session = {
        name: sessionName,
        timestamp: new Date().toISOString(),
        tabs: tabs.map(tab => ({
            url: tab.url,
            title: tab.title
        }))
    };

    chrome.storage.local.get(['sessions'], (result) => {
        const sessions = result.sessions || [];
        sessions.push(session);
        chrome.storage.local.set({ sessions }, () => {
            document.getElementById('sessionName').value = '';
            loadSessions();
        });
    });
}

function loadSessions() {
    const sessionsList = document.getElementById('sessionsList');
    sessionsList.innerHTML = '';

    chrome.storage.local.get(['sessions'], (result) => {
        const sessions = result.sessions || [];
        sessions.forEach((session, index) => {
            const sessionElement = createSessionElement(session, index);
            sessionsList.appendChild(sessionElement);
        });
    });
}

function createSessionElement(session, index) {
    const div = document.createElement('div');
    div.className = 'session-item';
    
    const nameSpan = document.createElement('span');
    nameSpan.textContent = session.name;
    
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'session-actions';
    
    const restoreBtn = document.createElement('button');
    restoreBtn.textContent = 'Restore';
    restoreBtn.onclick = () => restoreSession(session);
    
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.className = 'delete-btn';
    deleteBtn.onclick = () => deleteSession(index);
    
    actionsDiv.appendChild(restoreBtn);
    actionsDiv.appendChild(deleteBtn);
    
    div.appendChild(nameSpan);
    div.appendChild(actionsDiv);
    
    return div;
}

async function restoreSession(session) {
    const createWindow = await chrome.windows.create({ focused: true });
    
    for (const tab of session.tabs) {
        chrome.tabs.create({
            windowId: createWindow.id,
            url: tab.url
        });
    }
    
    // Remove the initial blank tab that's created with the new window
    chrome.tabs.remove(createWindow.tabs[0].id);
}

function deleteSession(index) {
    chrome.storage.local.get(['sessions'], (result) => {
        const sessions = result.sessions || [];
        sessions.splice(index, 1);
        chrome.storage.local.set({ sessions }, loadSessions);
    });
}

function exportSessions() {
    chrome.storage.local.get(['sessions'], (result) => {
        const sessions = result.sessions || [];
        const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        chrome.downloads.download({
            url: url,
            filename: `tabtrack_sessions_${new Date().toISOString().slice(0,10)}.json`
        });
    });
}

function handleImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const importedSessions = JSON.parse(e.target.result);
            chrome.storage.local.get(['sessions'], (result) => {
                const currentSessions = result.sessions || [];
                const newSessions = [...currentSessions, ...importedSessions];
                chrome.storage.local.set({ sessions: newSessions }, () => {
                    loadSessions();
                    alert('Sessions imported successfully!');
                });
            });
        } catch (error) {
            alert('Error importing sessions. Please make sure the file is valid.');
        }
    };
    reader.readAsText(file);
}
