async function getSiftState() {
  return await chrome.storage.local.get({
    connected: false,
    username: null,
    inboxCount: 0,
    favoritesCount: 0,
    recentSaves: [],
    enabled: true,
  });
}

async function initializeDevelopmentState() {
  const state = await chrome.storage.local.get("initialized");

  if (state.initialized) {
    return;
  }

  await chrome.storage.local.set({
    initialized: true,

    connected: true,

    username: "Ghasty",

    inboxCount: 12,

    favoritesCount: 8,

    recentSaves: [
      {
        username: "@john",
        text: "TCP explanation",
        url: "https://x.com/john/status/123",
      },
      {
        username: "@alice",
        text: "PostgreSQL optimization",
        url: "https://x.com/alice/status/456",
      },
      {
        username: "@bob",
        text: "System design notes",
        url: "https://x.com/bob/status/789",
      },
    ],

    enabled: true,
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({
    username: "Gbolahan",
    theme: "dark",
    lastSavedUrl: "",
  });
});

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.type === "PAGE_INFO") {
    console.log("Page information received:");
    console.log("URL:", message.url);
    console.log("Title:", message.title);
  }

  if (message.type === "HELLO") {
    sendResponse({
      success: true,
      message: "Hello from Sift's service worker!",
    });
  }

  if (message.type === "GET_EXTENSION_INFO") {
    sendResponse({
      name: "Sift",
      version: "0.1.0",
    });
  }

  if (message.type === "GET_SETTINGS") {
    chrome.storage.local
      .get(["username", "theme", "lastSavedUrl"])
      .then((settings) => {
        sendResponse(settings);
      });

    return true;
  }

  if (message.type === "SAVE_BOOKMARK") {
    const bookmark = message.bookmark;

    console.log("Received bookmark:", bookmark);

    const state = await getSiftState();

    const alreadySaved = state.recentSaves.some(
      (save) => save.url === bookmark.url,
    );

    if (alreadySaved) {
      sendResponse({
        success: true,
        status: "ALREADY_SAVED",
      });

      return true;
    }

    const newSave = {
      username: `@${bookmark.authorUsername}`,
      text: bookmark.text,
      url: bookmark.url,
    };

    const recentSaves = [newSave, ...state.recentSaves].slice(0, 5);

    await chrome.storage.local.set({
      inboxCount: state.inboxCount + 1,
      recentSaves,
    });

    sendResponse({
      success: true,
      status: "SAVED",
    });

    return true;
  }

  if (message.type === "GET_EXTENSION_STATE") {
    const state = await getSiftState();

    console.log("STATE FROM STORAGE:", state);

    sendResponse(state);

    return true;
  }
});

initializeDevelopmentState();
