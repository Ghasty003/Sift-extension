// A regular Set (not WeakSet) on purpose: we need to be able to clear it
// when the user re-enables Sift after disabling, so previously-processed
// tweets get their buttons re-injected instead of being silently skipped.
const processedTweets = new Set();

let siftEnabled = true;

async function loadEnabledState() {
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  siftEnabled = enabled;
}

function removeAllSiftButtons() {
  document
    .querySelectorAll('[data-sift-button="true"]')
    .forEach((btn) => btn.remove());
  processedTweets.clear();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("enabled" in changes)) return;

  siftEnabled = changes.enabled.newValue;

  if (siftEnabled) {
    scanTweets();
  } else {
    removeAllSiftButtons();
  }
});

function extractRepostContext(article) {
  // X renders a small "<Name> reposted" line above the actual tweet when
  // viewing a repost in the timeline — structurally separate from the
  // tweet's own author block, usually the first text content inside the
  // article before the author link.
  //
  // ⚠️ Best-effort: depends on the literal text "reposted" and X's current
  // DOM shape. The author name's own text is excluded by requiring this
  // block appear before the main author link in document order.
  const socialContextEl = [...article.querySelectorAll("span")].find((span) =>
    /reposted$/i.test(span.textContent?.trim() ?? ""),
  );

  if (!socialContextEl) {
    return { repostedByName: "", repostedByUsername: "" };
  }

  const repostedByName = socialContextEl.textContent
    .replace(/reposted$/i, "")
    .trim();

  // The reposter's own profile link, if present nearby, gives us their
  // username too — not guaranteed to exist, so this degrades gracefully.
  const container = socialContextEl.closest("div");
  const profileLink = container?.querySelector('a[href^="/"][role="link"]');
  const repostedByUsername =
    profileLink?.getAttribute("href")?.replace(/^\//, "") ?? "";

  return { repostedByName, repostedByUsername };
}

function extractAuthorName(article, username) {
  if (!username) {
    return "";
  }

  const displayNameLink = [...article.querySelectorAll("a")].find((link) => {
    const href = link.getAttribute("href");
    const text = link.innerText.trim();

    return href === `/${username}` && text && text !== `@${username}`;
  });

  return displayNameLink?.innerText.trim() ?? "";
}

function extractAvatarUrl(scope) {
  // X wraps the author's avatar in a container whose data-testid starts
  // with "UserAvatar-Container-" — this holds for both the outer tweet
  // and a nested quote-tweet card.
  const img = scope.querySelector('[data-testid^="UserAvatar-Container"] img');
  return img?.src ?? "";
}

function getStatusIdFromUrl(url) {
  return url.match(/\/status\/(\d+)/)?.[1] ?? "";
}

function getStatusIdentity(url) {
  const parsed = url.match(/x\.com\/([^/]+)\/status\/(\d+)/);

  return {
    username: parsed?.[1] ?? "",
    tweetId: parsed?.[2] ?? getStatusIdFromUrl(url),
  };
}

function findQuotedCardForLink(article, link) {
  const actionBar = findActionBar(article);
  const candidates = [...article.querySelectorAll('[role="link"]')].filter(
    (container) =>
      container.contains(link) &&
      (container.querySelector('[data-testid="tweetText"]') ||
        container.querySelector('[data-testid="tweetPhoto"]') ||
        container.querySelector('[data-testid="videoPlayer"]')) &&
      (!actionBar || !container.contains(actionBar)),
  );

  // X uses both <div> and <a> role="link" wrappers for quote cards and may
  // nest several of them. Use the
  // smallest matching wrapper so author/text/avatar queries stay inside the
  // quoted post instead of leaking out to the outer post.
  return candidates.reduce(
    (smallest, candidate) =>
      smallest?.contains(candidate) ? candidate : smallest,
    null,
  );
}

function findMainStatusLink(article) {
  const statusLinks = [...article.querySelectorAll('a[href*="/status/"]')];

  return (
    statusLinks.find((link) => !findQuotedCardForLink(article, link)) ??
    statusLinks[0] ??
    null
  );
}

function getQuotedCardScopes(article) {
  const scopes = [];

  for (const link of article.querySelectorAll('a[href*="/status/"]')) {
    const scope = findQuotedCardForLink(article, link);
    if (scope && !scopes.includes(scope)) {
      scopes.push(scope);
    }
  }

  return scopes;
}

function getBackgroundImageUrl(element) {
  const backgroundImage = getComputedStyle(element).backgroundImage;
  const match = backgroundImage.match(/^url\(["']?(.*?)["']?\)$/);
  return match?.[1] ?? "";
}

function extractTweetMedia(scope, excludedScopes = []) {
  const media = [];
  const seen = new Set();

  function isExcluded(element) {
    return excludedScopes.some((excluded) => excluded.contains(element));
  }

  function add(type, previewUrl) {
    if (!previewUrl || seen.has(previewUrl) || media.length >= 4) return;
    seen.add(previewUrl);
    media.push({ type, previewUrl });
  }

  for (const image of scope.querySelectorAll('[data-testid="tweetPhoto"] img')) {
    if (isExcluded(image)) continue;
    add("IMAGE", image.currentSrc || image.src);
  }

  for (const player of scope.querySelectorAll('[data-testid="videoPlayer"]')) {
    if (isExcluded(player)) continue;

    const video = player.querySelector("video");
    const poster =
      video?.poster ||
      video?.getAttribute("poster") ||
      player.querySelector("img")?.currentSrc ||
      player.querySelector("img")?.src ||
      getBackgroundImageUrl(player);

    add("VIDEO", poster);
  }

  return media;
}

function getConversationTimelineReply(article, tweetId) {
  const pageTweetId = location.pathname.match(/\/status\/(\d+)/)?.[1];

  // This fallback is only for a post-detail page. The post whose ID is in
  // the URL is the conversation root; any other post needs more evidence
  // before we call it a reply.
  if (!pageTweetId || !tweetId || pageTweetId === tweetId) {
    return false;
  }

  // X groups the root post and its replies inside one labelled timeline.
  // Looking for the root post in that same timeline keeps this heuristic
  // away from ordinary Home/Search/Profile timelines.
  const timeline = article.closest('[aria-label*="Timeline" i]');
  if (!timeline) {
    return false;
  }

  const rootArticle = [...timeline.querySelectorAll('article[data-testid="tweet"]')]
    .find((candidate) => {
      const statusLink = candidate.querySelector('a[href*="/status/"]');
      return getStatusIdFromUrl(statusLink?.href ?? "") === pageTweetId;
    });

  if (!rootArticle) {
    return false;
  }

  // Related recommendations can be appended to the same timeline after a
  // "Discover more"/"More posts" heading. Do not mislabel those as replies.
  const recommendationBoundary = [...
    timeline.querySelectorAll('[role="heading"], h1, h2, h3'),
  ].find((heading) =>
    /^(discover more|more posts)$/i.test(heading.textContent?.trim() ?? ""),
  );

  if (
    recommendationBoundary &&
    rootArticle.compareDocumentPosition(recommendationBoundary) &
      Node.DOCUMENT_POSITION_FOLLOWING &&
    recommendationBoundary.compareDocumentPosition(article) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ) {
    return false;
  }

  return Boolean(
    rootArticle.compareDocumentPosition(article) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

function extractReplyContext(article, tweetId) {
  // X renders "Replying to @user [@user2 ...]" as its own block directly
  // above the tweet's own author line. We treat presence of that block as
  // "this is a reply," and take the first @mention as who it's replying to.
  //
  // ⚠️ Best-effort: this depends on the literal text "Replying to" and X's
  // current DOM shape. Verify against a live reply before relying on it.
  const replyBlock = [...article.querySelectorAll("div")].find((div) =>
    div.textContent?.trim().startsWith("Replying to"),
  );

  if (!replyBlock) {
    return {
      isReply: getConversationTimelineReply(article, tweetId),
      // X does not expose the exact parent account in this compact thread
      // layout. Leave it empty so the UI can say "Reply in thread" rather
      // than displaying an incorrect username.
      replyToUsername: "",
    };
  }

  const mentionLink = replyBlock.querySelector('a[href^="/"]');
  const replyToUsername =
    mentionLink?.getAttribute("href")?.replace(/^\//, "") ?? "";

  return { isReply: true, replyToUsername };
}

function extractQuotedTweet(article, mainTweetId) {
  // Compare by the actual tweet ID parsed from each link, not the raw href
  // string — X often renders more than one anchor pointing at the same
  // status (the timestamp link, the text-wrapping link, etc.) with slightly
  // different href text, which made a plain string comparison wrongly
  // conclude "this is a different, quoted tweet" when it was actually the
  // same tweet linked twice.
  const statusLinks = [...article.querySelectorAll('a[href*="/status/"]')];

  for (const link of statusLinks) {
    const quotedScope = findQuotedCardForLink(article, link);
    if (!quotedScope) continue;

    const { username: authorUsername, tweetId } = getStatusIdentity(link.href);

    if (!tweetId || tweetId === mainTweetId) continue;
    const authorName = extractAuthorName(quotedScope, authorUsername);
    const authorAvatarUrl = extractAvatarUrl(quotedScope);
    const text =
      quotedScope.querySelector('[data-testid="tweetText"]')?.innerText ?? "";
    const createdAt =
      quotedScope.querySelector("time")?.getAttribute("datetime") ?? "";
    const media = extractTweetMedia(quotedScope);

    return {
      tweetId,
      url: link.href,
      authorUsername,
      authorName,
      authorAvatarUrl,
      text,
      createdAt,
      media,
    };
  }

  return null;
}

function extractTweet(article) {
  const quotedCardScopes = getQuotedCardScopes(article);
  const textElement = [...
    article.querySelectorAll('[data-testid="tweetText"]'),
  ].find(
    (candidate) =>
      !quotedCardScopes.some((quotedScope) => quotedScope.contains(candidate)),
  );
  const text = textElement?.innerText ?? "";

  const statusLink = findMainStatusLink(article);
  const statusIdentity = getStatusIdentity(statusLink?.href ?? "");

  const url = statusLink?.href ?? "";
  const authorUsername = statusIdentity.username;
  const tweetId = statusIdentity.tweetId;
  const createdAt =
    article.querySelector("time")?.getAttribute("datetime") ?? "";
  const authorName = extractAuthorName(article, authorUsername);
  const authorAvatarUrl = extractAvatarUrl(article);
  const { isReply, replyToUsername } = extractReplyContext(article, tweetId);
  const quotedTweet = extractQuotedTweet(article, tweetId);
  const media = extractTweetMedia(article, quotedCardScopes);

  const { repostedByName, repostedByUsername } = extractRepostContext(article);

  return {
    url,
    tweetId,
    authorUsername,
    authorName,
    authorAvatarUrl,
    text,
    createdAt,
    media,
    isReply,
    replyToUsername,
    quotedTweet,
    repostedByName,
    repostedByUsername,
  };
}

function findActionBar(tweet) {
  return tweet.querySelector('[role="group"]');
}

function getSiftIcon(type) {
  const icons = {
    // Idle state — outline funnel. Distinct from X's own bookmark ribbon,
    // and a literal nod to "Sift" (filtering/sifting posts).
    bookmark: `
      <svg viewBox="0 0 24 24" width="20" height="20"
           fill="none" stroke="currentColor"
           stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
        <path d="M3.5 4h17L13.6 13v6.5h-3.2V13z"/>
      </svg>
    `,

    // Saved state — same funnel, filled solid. Mirrors the outline-to-filled
    // convention X's own bookmark icon already uses, so the interaction still
    // feels native, but the shape stays uniquely Sift's.
    check: `
      <svg viewBox="0 0 24 24" width="20" height="20"
           fill="currentColor" stroke="none">
        <path d="M3.5 4h17L13.6 13v6.5h-3.2V13z"/>
      </svg>
    `,

    retry: `
      <svg viewBox="0 0 24 24" width="20" height="20"
           fill="none" stroke="currentColor"
           stroke-width="2" stroke-linejoin="round" stroke-linecap="round">
        <path d="M20 11a8.1 8.1 0 0 0-15.5-3"/>
        <path d="M4 4v5h5"/>
        <path d="M4 13a8.1 8.1 0 0 0 15.5 3"/>
        <path d="M20 20v-5h-5"/>
      </svg>
    `,
  };

  return icons[type];
}

function setButtonState(button, state) {
  button.classList.remove("sift-saving", "sift-saved", "sift-error");

  if (state === "idle") {
    button.disabled = false;
    button.innerHTML = getSiftIcon("bookmark");
    button.setAttribute("aria-label", "Save to Sift");
    button.title = "Save to Sift";
  }

  if (state === "saving") {
    button.classList.add("sift-saving");
    button.disabled = true;
    button.innerHTML = `
      <span class="sift-spinner"></span>
    `;
    button.setAttribute("aria-label", "Saving to Sift...");
    button.title = "Saving to Sift...";
  }

  if (state === "saved") {
    button.classList.add("sift-saved");
    button.disabled = true;
    button.innerHTML = getSiftIcon("check");
    button.setAttribute("aria-label", "Saved to Sift");
    button.title = "Saved to Sift";
  }

  if (state === "error") {
    button.classList.add("sift-error");
    button.disabled = false;
    button.innerHTML = getSiftIcon("retry");
    button.setAttribute("aria-label", "Retry saving to Sift");
    button.title = "Retry saving to Sift";
  }
}

function createSiftButton(tweet) {
  const button = document.createElement("button");

  button.type = "button";
  button.className = "sift-button";
  button.dataset.siftButton = "true";

  setButtonState(button, "idle");

  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();

    setButtonState(button, "saving");

    const data = extractTweet(tweet);

    try {
      const response = await chrome.runtime.sendMessage({
        type: "SAVE_BOOKMARK",
        bookmark: data,
      });

      if (response?.success) {
        setButtonState(button, "saved");
      } else {
        setButtonState(button, "error");
      }
    } catch (error) {
      console.error("Sift save failed:", error);

      setButtonState(button, "error");
    }
  });

  return button;
}

function injectSiftButton(tweet) {
  if (tweet.querySelector('[data-sift-button="true"]')) {
    return;
  }

  const actionBar = findActionBar(tweet);

  if (!actionBar) {
    return;
  }

  const button = createSiftButton(tweet);

  const shareButton = actionBar.querySelector('[data-testid="share"]');

  if (shareButton) {
    shareButton.parentElement?.before(button);
  } else {
    actionBar.appendChild(button);
  }
}

function processTweet(tweet) {
  if (!siftEnabled) {
    return;
  }

  if (processedTweets.has(tweet)) {
    return;
  }

  processedTweets.add(tweet);

  console.log("Tweet detected:", extractTweet(tweet));

  injectSiftButton(tweet);
}

function scanTweets() {
  const tweets = document.querySelectorAll('article[data-testid="tweet"]');

  for (const tweet of tweets) {
    processTweet(tweet);
  }
}

loadEnabledState().then(() => {
  scanTweets();
});

const observer = new MutationObserver(() => {
  scanTweets();
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});
