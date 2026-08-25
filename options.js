async function loadSettings() {
  const state = await chrome.storage.local.get({
    connected: false,
    username: null,
    enabled: true,
  });

  const status = document.getElementById("connection-status");

  const account = document.getElementById("account-name");

  const enabled = document.getElementById("enabled");

  status.textContent = state.connected ? "● Connected" : "○ Disconnected";

  account.textContent = state.username ?? "Not connected";

  enabled.checked = state.enabled;
}

loadSettings();

document.getElementById("enabled").addEventListener("change", async (event) => {
  await chrome.storage.local.set({
    enabled: event.target.checked,
  });
});

document.getElementById("disconnect").addEventListener("click", async () => {
  await chrome.storage.local.set({
    connected: false,
    username: null,
  });

  await loadSettings();
});
