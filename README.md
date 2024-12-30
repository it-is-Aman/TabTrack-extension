# TabTrack - Tab Session Manager 🚀

**TabTrack** is a Chrome extension that helps you efficiently manage your browsing sessions. With TabTrack, you can group, save, and restore browser tabs, making it easier to organize your workflow and revisit projects.

---

## Features

- **Save Current Tabs**: Quickly save all your open tabs as a named session.
- **Restore Tabs**: Open a previously saved session with one click.
- **Session Management**: Import and export sessions for backup or sharing.
- **User-Friendly Interface**: Intuitive and responsive design for seamless navigation.

---

## Installation

1. Download or clone this repository:
   ```bash
   git clone https://github.com/yourusername/tabtrack.git
   ```
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (top-right corner).
4. Click **Load unpacked** and select the project folder.

---

## How to Use

1. **Save Tabs**:
   - Click on the TabTrack icon in your browser toolbar.
   - Enter a session name and click **Save Current Tabs**.

2. **Restore Tabs**:
   - Browse the list of saved sessions in the popup.
   - Click on a session to open all tabs.

3. **Import/Export Sessions**:
   - Use the **Import** button to upload a `.json` file with saved sessions.
   - Use the **Export** button to download your current sessions as a backup.

---

## Permissions

TabTrack requests the following permissions for functionality:

- `tabs`: Access browser tabs for saving and restoring.
- `storage`: Save session data locally.
- `downloads`: Enable exporting session data.

---

## Tech Stack

- **Manifest V3** for Chrome Extensions.
- **HTML, CSS, JavaScript** for the UI and functionality.
- **Chrome APIs** for tab and storage management.

---

## Future Enhancements

- Add session search functionality.
- Enable cloud sync for saved sessions.
- Support additional browsers (Firefox, Edge).

---

## Contributing

Contributions are welcome! If you'd like to add features or fix issues, feel free to fork the repository and submit a pull request.
