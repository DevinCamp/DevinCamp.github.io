const { app, BrowserWindow, shell, Menu } = require("electron");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1400, height: 860, minWidth: 700, minHeight: 500,
    backgroundColor: "#0b0e13", title: "Live Walls Chart",
    icon: path.join(__dirname, "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, "index.html"));
  // open any outside links in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
}
Menu.setApplicationMenu(null);
app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
