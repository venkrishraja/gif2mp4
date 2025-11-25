/* eslint-disable no-console */
const statusEl = document.getElementById('status');
const closeButton = document.getElementById('btn');

let closableTabIds = [];
let redgifsTokenPromise;

function setStatus(message) {
  statusEl.textContent = message;
}

function getAllWindows() {
  return new Promise((resolve, reject) => {
    chrome.windows.getAll({ populate: true }, (windows) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }

      resolve(windows || []);
    });
  });
}

function extractSlug(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const candidate = url.pathname.split('/').filter(Boolean).pop();
    if (!candidate) {
      return null;
    }

    const [base] = candidate.split('?');
    return base.split('.')[0].split('-')[0];
  } catch {
    return null;
  }
}

function getRedgifsSlug(tabUrl) {
  const slug = extractSlug(tabUrl);
  if (!slug) {
    return null;
  }

  return slug;
}

async function getRedgifsToken() {
  if (!redgifsTokenPromise) {
    redgifsTokenPromise = (async () => {
      try {
        const response = await fetch('https://api.redgifs.com/v2/auth/temporary', {
          method: 'POST',
          cache: 'no-store'
        });

        if (!response.ok) {
          throw new Error(`Auth failed with status ${response.status}`);
        }

        const payload = await response.json();
        return payload?.access_token ?? null;
      } catch (error) {
        console.error('Unable to create RedGIFs session', error);
        return null;
      }
    })();
  }

  const token = await redgifsTokenPromise;
  if (!token) {
    redgifsTokenPromise = undefined;
  }

  return token;
}

async function fetchRedgifsMp4(slug) {
  const token = await getRedgifsToken();
  if (!token) {
    return null;
  }

  try {
    const response = await fetch(`https://api.redgifs.com/v2/gifs/${slug}`, {
      headers: {
        Authorization: `Bearer ${token}`
      },
      cache: 'no-store'
    });

    if (!response.ok) {
      throw new Error(`Lookup failed with status ${response.status}`);
    }

    const payload = await response.json();
    return payload?.gif?.urls?.hd || payload?.gif?.urls?.sd || null;
  } catch (error) {
    console.error(`Failed to load RedGIF ${slug}`, error);
    return null;
  }
}

async function resolveDownloadUrl(tab) {
  const tabUrl = tab.url || '';

  if (!tabUrl) {
    return null;
  }

  const lowerCaseUrl = tabUrl.toLowerCase();

  if (lowerCaseUrl.includes('imgur.com') && lowerCaseUrl.includes('gifv')) {
    return tabUrl.replace(/gifv/gi, 'mp4');
  }

  if (lowerCaseUrl.includes('redgifs.com')) {
    const slug = getRedgifsSlug(tabUrl);
    if (!slug) {
      return null;
    }

    return fetchRedgifsMp4(slug);
  }

  return null;
}

async function collectDownloads(windows) {
  const downloadUrls = [];
  const tabIds = [];

  for (const window of windows) {
    for (const tab of window.tabs || []) {
      const url = await resolveDownloadUrl(tab);
      if (url) {
        downloadUrls.push(url);
        tabIds.push(tab.id);
      }
    }
  }

  return { downloadUrls, tabIds };
}

function downloadFile(url) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url }, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }

      resolve(downloadId);
    });
  });
}

async function downloadAll(urls) {
  const results = await Promise.allSettled(urls.map((url) => downloadFile(url)));
  return results.filter((result) => result.status === 'fulfilled').length;
}

function closeTabs(tabIds) {
  chrome.tabs.remove(tabIds, () => {
    const error = chrome.runtime.lastError;
    if (error) {
      console.error('Unable to close tabs', error);
      setStatus('Downloads finished, but tabs could not be closed.');
      return;
    }

    closeButton.hidden = true;
    setStatus('Downloads finished and tabs closed.');
  });
}

async function init() {
  setStatus('Scanning open tabs…');

  closeButton.addEventListener('click', () => {
    if (closableTabIds.length === 0) {
      return;
    }
    closeTabs([...closableTabIds]);
  });

  try {
    const windows = await getAllWindows();
    const { downloadUrls, tabIds } = await collectDownloads(windows);
    closableTabIds = tabIds;

    if (!downloadUrls.length) {
      setStatus('No RedGIFs or Imgur GIF tabs detected.');
      return;
    }

    const startedDownloads = await downloadAll(downloadUrls);

    if (!startedDownloads) {
      setStatus('Unable to start downloads. Check DevTools for details.');
      return;
    }

    const noun = startedDownloads === 1 ? 'download' : 'downloads';
    setStatus(`Started ${startedDownloads} ${noun}.`);

    if (tabIds.length) {
      closeButton.hidden = false;
    }
  } catch (error) {
    console.error('Failed to scan tabs', error);
    setStatus('Something went wrong. Open DevTools for details.');
  }
}

init();
