const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve static files from 'public' directory first, then root fallback
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Blacklist of system header/footer/UI text links that are not real user comments
const SYSTEM_IGNORED_USERS = new Set([
  'privacy', 'terms', 'meta', 'about', 'help', 'api', 'jobs', 'locations',
  'instagram', 'facebook', 'twitter', 'tiktok', 'youtube', 'login', 'log in',
  'signup', 'sign up', 'explore', 'reels', 'messages', 'direct', 'notifications',
  'profile', 'search', 'home', 'top accounts', 'hashtags', 'contact uploading',
  'meta verified', 'threads', 'cookie preferences', 'view replies', 'hide replies',
  'reply', 'like', 'likes', 'follow', 'following', 'verified', 'comments',
  'view all comments', 'load more comments', 'privacy policy', 'terms of use'
]);

// In-memory active Instagram session store
let activeInstagramSession = {
  sessionId: '',
  username: '',
  loggedIn: false,
};

// ---------------------------------------------------------------------------
// Fisher-Yates shuffle — provably unbiased in-place shuffle algorithm
// ---------------------------------------------------------------------------
function fisherYatesShuffle(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Platform detection helper
// ---------------------------------------------------------------------------
function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  return null;
}

// ---------------------------------------------------------------------------
// Cumulative Auto-scroll & Click "Load More Comments" Loop
// ---------------------------------------------------------------------------
async function autoScrollAndExpand(page, maxIterations = 80, delayMs = 600, cumulativeDomComments = [], seenDomKeys = new Set()) {
  for (let i = 0; i < maxIterations; i++) {
    // 1. Remove login modal overlays & click expansion buttons
    await page.evaluate(() => {
      const overlays = document.querySelectorAll('div[role="dialog"], div[role="presentation"]');
      overlays.forEach((o) => {
        const txt = (o.textContent || '').toLowerCase();
        if (txt.includes('log in') || txt.includes('sign up') || txt.includes('see more from')) {
          try {
            o.remove();
          } catch (_) {}
        }
      });
      document.body.style.overflow = 'auto';
      document.documentElement.style.overflow = 'auto';

      const candidates = Array.from(
        document.querySelectorAll('button, div[role="button"], svg[aria-label="Load more comments"], span')
      );
      candidates.forEach((el) => {
        const target = el.closest('button, div[role="button"]') || el;
        const txt = (target.textContent || target.getAttribute('aria-label') || '').toLowerCase();
        if (
          txt.includes('load more') ||
          txt.includes('view more') ||
          txt.includes('more comments') ||
          txt.includes('view replies') ||
          target.getAttribute('aria-label') === 'Load more comments'
        ) {
          try {
            target.click();
          } catch (_) {}
        }
      });

      window.scrollBy(0, 4500);
      document.querySelectorAll('ul, div[role="dialog"], [data-e2e="comment-list"], article').forEach((c) => {
        if (c.scrollHeight > c.clientHeight) {
          c.scrollTop += 4500;
        }
      });
    });

    // 2. Extract DOM comments AT THIS STEP before virtual scroll unmounts them
    const stepComments = await page.evaluate(() => {
      const results = [];
      const IGNORED = [
        'privacy', 'terms', 'meta', 'about', 'help', 'api', 'jobs', 'locations',
        'instagram', 'facebook', 'twitter', 'tiktok', 'youtube', 'login', 'log in',
        'signup', 'sign up', 'explore', 'reels', 'messages', 'direct', 'notifications',
        'profile', 'search', 'home', 'top accounts', 'hashtags', 'contact uploading',
        'meta verified', 'threads', 'cookie preferences', 'view replies', 'hide replies',
        'reply', 'like', 'likes', 'follow', 'following', 'verified', 'comments',
        'view all comments', 'load more comments', 'privacy policy'
      ];

      const selectors = ['ul._a9ym li', 'ul li', 'div._a9zs', 'div.x9f6066', '[data-e2e="comment-item"]'];
      const items = document.querySelectorAll(selectors.join(', '));

      items.forEach((li) => {
        const userLink =
          li.querySelector('h3 a') ||
          li.querySelector('a[role="link"]') ||
          li.querySelector('a[href^="/"]');
        if (!userLink) return;

        let username = userLink.textContent.trim().replace(/^@/, '');
        if (!username || username.includes(' ') || username.length > 35) return;

        const uLower = username.toLowerCase();
        if (IGNORED.includes(uLower)) return;

        let fullText = li.textContent || '';
        let text = fullText;
        if (text.startsWith(username)) {
          text = text.substring(username.length);
        }

        text = text
          .replace(/\b\d+[smhdw]\b/gi, '')
          .replace(/\b(Reply|Like|Likes|See translation|View replies \(\d+\)|Hide replies)\b/gi, '')
          .replace(/\s+/g, ' ')
          .trim();

        if (!text) {
          const spans = Array.from(li.querySelectorAll('span'));
          let best = '';
          spans.forEach((s) => {
            const t = s.textContent.trim();
            if (t && t.toLowerCase() !== uLower && !IGNORED.includes(t.toLowerCase())) {
              if (t.includes('@') || t.length > best.length) {
                best = t;
              }
            }
          });
          text = best;
        }

        results.push({ username, text });
      });

      return results;
    });

    // 3. Accumulate step comments into cumulative list
    stepComments.forEach((c) => {
      if (c && c.username) {
        const key = (c.username + '_' + c.text.slice(0, 30)).toLowerCase();
        if (!seenDomKeys.has(key)) {
          seenDomKeys.add(key);
          cumulativeDomComments.push(c);
        }
      }
    });

    await page.waitForTimeout(delayMs);
  }
}

// ---------------------------------------------------------------------------
// Deep JSON inspector helper for network API interception
// ---------------------------------------------------------------------------
function extractCommentsFromJSON(obj, results, seenKeys) {
  if (!obj || typeof obj !== 'object') return;

  if (obj.text && typeof obj.text === 'string' && (obj.owner || obj.user || obj.author)) {
    const uObj = obj.owner || obj.user || obj.author;
    const username = uObj.username || uObj.unique_id || uObj.nickname || uObj.name;
    if (username && typeof username === 'string') {
      const uClean = username.replace(/^@/, '').trim();
      const uLower = uClean.toLowerCase();
      if (uClean && !SYSTEM_IGNORED_USERS.has(uLower)) {
        const key = (uLower + '_' + obj.text.slice(0, 40)).toLowerCase();
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          results.push({ username: uClean, text: obj.text.trim() });
        }
      }
    }
  }

  if (obj.text && obj.user && (obj.user.unique_id || obj.user.uid)) {
    const username = obj.user.unique_id || obj.user.nickname;
    const uClean = String(username).replace(/^@/, '').trim();
    const uLower = uClean.toLowerCase();
    if (uClean && !SYSTEM_IGNORED_USERS.has(uLower)) {
      const key = (uLower + '_' + String(obj.text).slice(0, 40)).toLowerCase();
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        results.push({ username: uClean, text: String(obj.text).trim() });
      }
    }
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractCommentsFromJSON(item, results, seenKeys);
    }
  } else {
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'object') {
        extractCommentsFromJSON(obj[key], results, seenKeys);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-platform DOM scraping logic
// ---------------------------------------------------------------------------
async function scrapeInstagram(page, maxIterations = 80) {
  const cumulativeDomComments = [];
  const seenDomKeys = new Set();
  await autoScrollAndExpand(page, maxIterations, 600, cumulativeDomComments, seenDomKeys);
  return cumulativeDomComments;
}

async function scrapeTikTok(page, maxIterations = 80) {
  const cumulativeDomComments = [];
  const seenDomKeys = new Set();
  await autoScrollAndExpand(page, maxIterations, 600, cumulativeDomComments, seenDomKeys);
  return cumulativeDomComments;
}

async function scrapeYouTube(page, maxIterations = 80) {
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(1500);
  const cumulativeDomComments = [];
  const seenDomKeys = new Set();
  await autoScrollAndExpand(page, maxIterations, 600, cumulativeDomComments, seenDomKeys);
  return cumulativeDomComments;
}

// ---------------------------------------------------------------------------
// Core Scraper Runner Function with Saved Session Cookie Support
// ---------------------------------------------------------------------------
async function scrapeAllCommentsFromUrl(postUrl, scrapeDepth = 'full', sessionId = '') {
  const platform = detectPlatform(postUrl);
  if (!platform) {
    throw new Error(
      'Could not detect platform. Please provide an Instagram, TikTok, or YouTube URL.'
    );
  }

  let maxIterations = 90;
  if (scrapeDepth === 'standard') maxIterations = 30;
  else if (scrapeDepth === 'deep') maxIterations = 100;
  else if (scrapeDepth === 'full') maxIterations = 200;

  let browser = null;
  const interceptedComments = [];
  const interceptedSeen = new Set();

  // Use explicitly passed sessionId OR saved activeInstagramSession
  const effectiveSessionId = (sessionId && sessionId.trim()) || activeInstagramSession.sessionId;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: DESKTOP_UA,
      viewport: { width: 1366, height: 900 },
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    // Attach Session Cookie across both .instagram.com and www.instagram.com
    if (effectiveSessionId && typeof effectiveSessionId === 'string' && effectiveSessionId.trim()) {
      const cleanSession = effectiveSessionId.trim();
      await context.addCookies([
        { name: 'sessionid', value: cleanSession, domain: '.instagram.com', path: '/' },
        { name: 'sessionid', value: cleanSession, domain: 'www.instagram.com', path: '/' },
      ]);
    }

    const page = await context.newPage();

    page.on('response', async (response) => {
      try {
        const u = response.url();
        const headers = response.headers();
        const contentType = headers['content-type'] || '';
        if (
          contentType.includes('json') &&
          (u.includes('graphql') || u.includes('comment') || u.includes('api/v1'))
        ) {
          const json = await response.json().catch(() => null);
          if (json) {
            extractCommentsFromJSON(json, interceptedComments, interceptedSeen);
          }
        }
      } catch (_) {}
    });

    const response = await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (response && response.status() >= 400) {
      throw new Error(`The page returned HTTP ${response.status()} error.`);
    }

    await page.waitForTimeout(3000);

    let domComments = [];
    if (platform === 'instagram') domComments = await scrapeInstagram(page, maxIterations);
    else if (platform === 'tiktok') domComments = await scrapeTikTok(page, maxIterations);
    else if (platform === 'youtube') domComments = await scrapeYouTube(page, maxIterations);

    await browser.close();
    browser = null;

    const combinedMap = new Map();
    [...interceptedComments, ...domComments].forEach((item) => {
      if (item && item.username) {
        const uLower = item.username.toLowerCase();
        if (!SYSTEM_IGNORED_USERS.has(uLower)) {
          const key = uLower;
          if (!combinedMap.has(key)) {
            combinedMap.set(key, item);
          } else {
            const existing = combinedMap.get(key);
            if ((item.text || '').length > (existing.text || '').length) {
              combinedMap.set(key, item);
            }
          }
        }
      }
    });

    const rawComments = Array.from(combinedMap.values());
    const indexedComments = rawComments.map((c, idx) => ({
      commentNumber: idx + 1,
      username: c.username,
      text: c.text || '',
      mentionsCount: (c.text.match(/@[a-zA-Z0-9_.]+/g) || c.text.match(/@/g) || []).length,
    }));

    return {
      platform,
      postUrl,
      totalComments: indexedComments.length,
      comments: indexedComments,
    };
  } catch (err) {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Selection engine — filtering, dedupe, Fisher-Yates draw
// ---------------------------------------------------------------------------
function runSelection(comments, opts = {}) {
  const {
    winnerCount = 15,
    backupCount = 3,
    minMentions = 0,
    requiredTag = '',
    uniqueOnly = true,
    excludeUsers = '',
  } = opts;

  const indexedComments = comments.map((c, idx) => ({
    commentNumber: idx + 1,
    username: c.username || '',
    text: c.text || '',
  }));

  let candidates = indexedComments.filter(
    (c) =>
      c.username &&
      c.username.trim().length > 0 &&
      !SYSTEM_IGNORED_USERS.has(c.username.trim().toLowerCase().replace(/^@/, ''))
  );

  const allUsernamesSet = new Set(candidates.map((c) => c.username.toLowerCase()));
  const uniqueUsersCount = allUsernamesSet.size;

  let excludedSet = new Set();
  if (Array.isArray(excludeUsers)) {
    excludedSet = new Set(excludeUsers.map((u) => String(u).trim().toLowerCase().replace(/^@/, '')));
  } else if (typeof excludeUsers === 'string' && excludeUsers.trim()) {
    excludedSet = new Set(
      excludeUsers
        .split(',')
        .map((u) => u.trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean)
    );
  }

  if (excludedSet.size > 0) {
    candidates = candidates.filter(
      (c) => !excludedSet.has(c.username.trim().toLowerCase().replace(/^@/, ''))
    );
  }

  if (minMentions && Number(minMentions) > 0) {
    const targetMentions = Number(minMentions);
    candidates = candidates.filter((c) => {
      const text = c.text || '';
      const matches = text.match(/@[a-zA-Z0-9_.]+/g) || text.match(/@/g);
      return matches && matches.length >= targetMentions;
    });
  }

  if (requiredTag && requiredTag.trim().length > 0) {
    const tag = requiredTag.trim().toLowerCase();
    candidates = candidates.filter((c) => (c.text || '').toLowerCase().includes(tag));
  }

  let duplicatesCount = 0;
  if (uniqueOnly) {
    const seen = new Set();
    const uniqueCandidates = [];
    for (const c of candidates) {
      const key = c.username.toLowerCase();
      if (seen.has(key)) {
        duplicatesCount++;
      } else {
        seen.add(key);
        uniqueCandidates.push(c);
      }
    }
    candidates = uniqueCandidates;
  }

  const shuffled = fisherYatesShuffle(candidates);

  const parsedWinnerCount = Math.max(1, Number(winnerCount) || 15);
  const parsedBackupCount = Math.max(0, Number(backupCount) || 3);

  const winners = shuffled.slice(0, parsedWinnerCount);
  const backups = shuffled.slice(parsedWinnerCount, parsedWinnerCount + parsedBackupCount);

  const timestamp = new Date().toISOString();
  const seed = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

  return {
    totalFetched: indexedComments.length,
    uniqueUsersCount,
    eligibleCount: candidates.length,
    duplicatesRemoved: duplicatesCount,
    allComments: indexedComments,
    winners,
    backups,
    audit: {
      timestamp,
      seed,
      algorithm: 'Fisher-Yates (Knuth) Shuffle',
      unbiased: true,
    },
  };
}

// ---------------------------------------------------------------------------
// API Endpoint: Log in to Instagram via Playwright & save session
// ---------------------------------------------------------------------------
app.post('/api/instagram-login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Instagram Username and Password are required.' });
  }

  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: DESKTOP_UA,
      viewport: { width: 1366, height: 900 },
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    // Add init script to mask automation
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(3000);

    // Dismiss cookie consent & language popups
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
      buttons.forEach((b) => {
        const txt = (b.textContent || '').toLowerCase();
        if (txt.includes('allow') || txt.includes('accept') || txt.includes('cookie') || txt.includes('decline')) {
          try { b.click(); } catch (_) {}
        }
      });
    });
    await page.waitForTimeout(1500);

    // Locate username field with fallback selectors
    const userSelector = 'input[name="username"], input[aria-label*="username" i], input[aria-label*="Phone" i], input[type="text"]';
    const userField = await page.waitForSelector(userSelector, { timeout: 15000 }).catch(() => null);

    if (!userField) {
      throw new Error(
        'Instagram automated login was blocked by anti-bot checks. Click the "🍪 Paste Session Cookie" tab right next to this form — it bypasses bot checks instantly!'
      );
    }

    await userField.fill(username.replace(/^@/, ''));

    // Locate password field
    const passSelector = 'input[name="password"], input[type="password"]';
    const passField = await page.waitForSelector(passSelector, { timeout: 10000 }).catch(() => null);
    if (!passField) {
      throw new Error('Could not find password input field. Please use the "🍪 Paste Session Cookie" tab!');
    }

    await passField.fill(password);

    // Submit login form
    const submitBtn = await page.$('button[type="submit"], button:has-text("Log in"), button:has-text("Log In")');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(7000);

    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name === 'sessionid');

    if (!sessionCookie || !sessionCookie.value) {
      const pageText = await page.textContent('body').catch(() => '');
      if (pageText.includes('incorrect') || pageText.includes('Password')) {
        throw new Error('Incorrect Instagram username or password.');
      } else if (pageText.includes('security code') || pageText.includes('Two-Factor') || pageText.includes('suspicious') || pageText.includes('verify')) {
        throw new Error('Instagram requested 2FA / Device Verification! Switch to the "🍪 Paste Session Cookie" tab above to sign in instantly.');
      }
      throw new Error('Automated login blocked by Instagram. Click the "🍪 Paste Session Cookie" tab above to sign in instantly!');
    }

    activeInstagramSession = {
      sessionId: sessionCookie.value,
      username: username.replace(/^@/, ''),
      loggedIn: true,
    };

    await browser.close();
    browser = null;

    return res.json({
      success: true,
      username: activeInstagramSession.username,
      message: `Successfully logged in as @${activeInstagramSession.username}! Session saved.`,
    });
  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    return res.status(500).json({ success: false, error: err.message || 'Login failed.' });
  }
});

app.post('/api/instagram-set-cookie', (req, res) => {
  const { sessionId, username } = req.body || {};
  if (!sessionId || !sessionId.trim()) {
    return res.status(400).json({ success: false, error: 'Session Cookie ID is required.' });
  }
  const cleanSession = sessionId.trim();
  const cleanUser = (username && username.trim().replace(/^@/, '')) || 'instagram_user';
  activeInstagramSession = {
    sessionId: cleanSession,
    username: cleanUser,
    loggedIn: true,
  };
  return res.json({
    success: true,
    username: cleanUser,
    message: `Instagram Session Cookie saved successfully for @${cleanUser}!`,
  });
});

app.post('/api/instagram-logout', (req, res) => {
  activeInstagramSession = { sessionId: '', username: '', loggedIn: false };
  res.json({ success: true, message: 'Logged out of Instagram.' });
});

app.get('/api/instagram-status', (req, res) => {
  res.json(activeInstagramSession);
});

// ---------------------------------------------------------------------------
// API Endpoint: Scrape public post URL & pick winners
// ---------------------------------------------------------------------------
app.post('/api/fetch-and-pick', async (req, res) => {
  const {
    postUrl,
    winnerCount = 15,
    backupCount = 3,
    minMentions = 0,
    requiredTag = '',
    uniqueOnly = true,
    excludeUsers = '',
    scrapeDepth = 'full',
    sessionId = '',
  } = req.body || {};

  if (!postUrl || typeof postUrl !== 'string' || !postUrl.trim()) {
    return res.status(400).json({ success: false, error: 'Post URL is required.' });
  }

  try {
    const data = await scrapeAllCommentsFromUrl(postUrl, scrapeDepth, sessionId);
    if (!data.comments.length) {
      return res.status(200).json({
        success: false,
        error:
          `No comments could be extracted from this ${data.platform} post. Social platforms require login to view more than 10 comments. Click "🔐 Instagram Login" in the header or use "Paste Comments Manually"!`,
        totalFetched: 0,
      });
    }

    const selectionResults = runSelection(data.comments, {
      winnerCount,
      backupCount,
      minMentions,
      requiredTag,
      uniqueOnly,
      excludeUsers,
    });

    return res.json({
      success: true,
      platform: data.platform,
      postUrl: data.postUrl,
      ...selectionResults,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || 'Unexpected server error.' });
  }
});

// ---------------------------------------------------------------------------
// API Endpoint: Scrape all comments & return CSV data
// ---------------------------------------------------------------------------
app.post('/api/fetch-all-comments', async (req, res) => {
  const { postUrl, scrapeDepth = 'full', sessionId = '', rawText = '' } = req.body || {};

  if (rawText && typeof rawText === 'string' && rawText.trim()) {
    const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
    const comments = lines.map((line, idx) => {
      const colonMatch = line.match(/^([@\w.\-]+)\s*[:\-]\s*(.*)$/);
      const spaceMatch = line.match(/^@([a-zA-Z0-9_.]+)\s+(.*)$/);
      let username = line.replace(/^@/, '');
      let text = '';
      if (colonMatch) {
        username = colonMatch[1].replace(/^@/, '');
        text = colonMatch[2].trim();
      } else if (spaceMatch) {
        username = spaceMatch[1];
        text = spaceMatch[2].trim();
      }
      return {
        commentNumber: idx + 1,
        username,
        text,
        mentionsCount: (text.match(/@[a-zA-Z0-9_.]+/g) || text.match(/@/g) || []).length,
      };
    });

    let rows = [['Comment Number', 'Username', 'Comment Text', 'Mentions Count']];
    comments.forEach((c) => {
      rows.push([c.commentNumber, '@' + c.username, c.text, c.mentionsCount]);
    });

    const csvContent = rows
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    return res.json({
      success: true,
      platform: 'manual',
      postUrl: 'Pasted Comments',
      totalComments: comments.length,
      comments,
      csvContent,
    });
  }

  if (!postUrl || typeof postUrl !== 'string' || !postUrl.trim()) {
    return res.status(400).json({ success: false, error: 'Post URL or pasted text is required.' });
  }

  try {
    const data = await scrapeAllCommentsFromUrl(postUrl, scrapeDepth, sessionId);

    let rows = [['Comment Number', 'Username', 'Comment Text', 'Mentions Count']];
    data.comments.forEach((c) => {
      rows.push([c.commentNumber, '@' + c.username, c.text, c.mentionsCount]);
    });

    const csvContent = rows
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    return res.json({
      success: true,
      platform: data.platform,
      postUrl: data.postUrl,
      totalComments: data.totalComments,
      comments: data.comments,
      csvContent,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || 'Unexpected server error.' });
  }
});

// ---------------------------------------------------------------------------
// API Endpoint: Pick from manually pasted text (100% reliable fallback)
// ---------------------------------------------------------------------------
app.post('/api/pick-from-text', (req, res) => {
  const {
    rawText,
    winnerCount = 15,
    backupCount = 3,
    minMentions = 0,
    requiredTag = '',
    uniqueOnly = true,
    excludeUsers = '',
  } = req.body || {};

  if (!rawText || typeof rawText !== 'string' || !rawText.trim()) {
    return res.status(400).json({ success: false, error: 'Raw comments text is required.' });
  }

  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const comments = lines.map((line) => {
    const colonMatch = line.match(/^([@\w.\-]+)\s*[:\-]\s*(.*)$/);
    if (colonMatch) {
      return {
        username: colonMatch[1].replace(/^@/, ''),
        text: colonMatch[2].trim(),
      };
    }

    const spaceMatch = line.match(/^@([a-zA-Z0-9_.]+)\s+(.*)$/);
    if (spaceMatch) {
      return {
        username: spaceMatch[1],
        text: spaceMatch[2].trim(),
      };
    }

    return {
      username: line.replace(/^@/, ''),
      text: '',
    };
  });

  const selectionResults = runSelection(comments, {
    winnerCount,
    backupCount,
    minMentions,
    requiredTag,
    uniqueOnly,
    excludeUsers,
  });

  return res.json({
    success: true,
    platform: 'manual',
    ...selectionResults,
  });
});

// ---------------------------------------------------------------------------
// Healthcheck & Fallback routing
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('*', (req, res) => {
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  const rootIndex = path.join(__dirname, 'index.html');

  if (fs.existsSync(publicIndex)) {
    res.sendFile(publicIndex);
  } else if (fs.existsSync(rootIndex)) {
    res.sendFile(rootIndex);
  } else {
    res.status(404).send('index.html not found');
  }
});

app.listen(PORT, () => {
  console.log(`🎉 Giveaway Winner Picker running at http://localhost:${PORT}`);
});
