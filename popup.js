document.addEventListener("DOMContentLoaded", async () => {
  const response = await chrome.runtime.sendMessage({
    type: "GET_EXTENSION_STATE",
  });

  if (!response) {
    return;
  }

  document.getElementById("inbox-count").textContent = response.inboxCount;

  document.getElementById("favorites-count").textContent =
    response.favoritesCount;

  renderRecentSaves(response.recentSaves);
});

function renderRecentSaves(saves) {
  const container = document.getElementById("recent-saves");

  container.replaceChildren();

  if (!Array.isArray(saves)) {
    console.warn("Invalid recentSaves:", saves);
    return;
  }

  for (const save of saves) {
    const item = document.createElement("div");
    item.className = "save-item";

    const username = document.createElement("strong");
    username.textContent = save.username;

    const text = document.createElement("span");
    text.textContent = save.text;

    item.append(username, text);

    container.appendChild(item);
  }
}

document.getElementById("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
