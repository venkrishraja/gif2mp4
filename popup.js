/* eslint-disable no-console */
const statusEl = document.getElementById('status');
const closeButton = document.getElementById('btn');

let closableTabIds = [];

const API_ENDPOINTS = [
  {
    test: (url) => url.includes('redgifs.com'),
    buildEndpoint: (slug) => `https://api.redgifs.com/v1/gfycats/${slug}`
  }
];

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

async function fetchMp4FromApi(endpoint) {
  try {
    const response = await fetch(endpoint, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const payload = await response.json();
    return payload?.gfyItem?.mp4Url ?? null;
  } catch (error) {
    console.error(`Failed to load ${endpoint}`, error);
    return null;
  }
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

function extractImgurId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    if (!parts.length) {
      return null;
    }

    let candidate = parts.pop();
    const reserved = new Set(['gallery', 'a']);
    if (reserved.has((candidate || '').toLowerCase()) && parts.length) {
      candidate = parts.pop();
    }

    if (!candidate) {
      return null;
    }

    const sanitized = candidate.split('.')[0];
    const segments = sanitized.split('-');
    const id = segments.pop();

    return id || null;
  } catch {
    return null;
  }
}

async function resolveDownloadUrl(tab) {
  const tabUrl = tab.url || '';

  if (!tabUrl) {
    return null;
  }

  const lowerCaseUrl = tabUrl.toLowerCase();

  if (lowerCaseUrl.includes('imgur.com')) {
    if (lowerCaseUrl.includes('gifv')) {
      return tabUrl.replace(/gifv/gi, 'mp4');
    }

    const imgurId = extractImgurId(tabUrl);
    if (imgurId) {
      return `https://i.imgur.com/${imgurId}.mp4`;
    }
  }

  const source = API_ENDPOINTS.find(({ test }) => test(lowerCaseUrl));
  if (!source) {
    return null;
  }

  const slug = extractSlug(tabUrl);
  if (!slug) {
    return null;
  }

  return fetchMp4FromApi(source.buildEndpoint(slug));
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
