const { app, BrowserWindow } = require('electron'); 
const path = require('node:path');

function createWindow() {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      // Preload scripts securely connect the web page to Node.js features
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Load your local index.html file
  mainWindow.loadFile('index.html');
}

// This method will be called when Electron has finished initialization
app.whenReady().then(() => {
  createWindow();

  // On macOS, apps commonly keep running until explicitly quit
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});