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

const IMGUR_RESERVED_SEGMENTS = new Set(['gallery', 'a', 'topic', 't']);

function extractImgurSlug(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    if (!parts.length) {
      return null;
    }

    let candidate = parts.pop();
    if (IMGUR_RESERVED_SEGMENTS.has((candidate || '').toLowerCase()) && parts.length) {
      candidate = parts.pop();
    }

    if (!candidate) {
      return null;
    }

    const sanitized = candidate.split('.')[0];
    const segments = sanitized.split('-');
    const slug = segments.pop();

    return slug || null;
  } catch {
    return null;
  }
}

function toImgurMp4(hash, ext) {
  if (!hash) {
    return null;
  }

  if (ext && !['.gif', '.gifv', 'gif', 'gifv'].includes(ext.toLowerCase())) {
    return `https://i.imgur.com/${hash}${ext.startsWith('.') ? ext : `.${ext}`}`;
  }

  return `https://i.imgur.com/${hash}.mp4`;
}

function pickImgurMedia(imageData) {
  if (!imageData) {
    return null;
  }

  if (Array.isArray(imageData.album_images?.images) && imageData.album_images.images.length) {
    return imageData.album_images.images[0];
  }

  if (Array.isArray(imageData.images) && imageData.images.length) {
    return imageData.images[0];
  }

  return imageData;
}

async function fetchImgurGalleryMedia(slug) {
  try {
    const response = await fetch(`https://imgur.com/gallery/${slug}.json`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Gallery lookup failed with status ${response.status}`);
    }

    const payload = await response.json();
    const image = payload?.data?.image;
    const media = pickImgurMedia(image);

    const directMp4 = media?.mp4;
    if (directMp4) {
      return directMp4;
    }

    const hash = media?.hash || image?.album_cover || image?.hash;
    const extension = media?.ext || image?.ext;

    return toImgurMp4(hash, extension);
  } catch (error) {
    console.error(`Failed to load Imgur gallery ${slug}`, error);
    return null;
  }
}

async function resolveImgurDownload(tabUrl, lowerCaseUrl) {
  if (lowerCaseUrl.includes('gifv')) {
    return tabUrl.replace(/gifv/gi, 'mp4');
  }

  const slug = extractImgurSlug(tabUrl);
  if (!slug) {
    return null;
  }

  if (lowerCaseUrl.includes('/gallery/') || lowerCaseUrl.includes('/a/')) {
    const galleryUrl = await fetchImgurGalleryMedia(slug);
    if (galleryUrl) {
      return galleryUrl;
    }
  }

  return toImgurMp4(slug);
}

async function resolveDownloadUrl(tab) {
  const tabUrl = tab.url || '';

  if (!tabUrl) {
    return null;
  }

  const lowerCaseUrl = tabUrl.toLowerCase();

  if (lowerCaseUrl.includes('imgur.com')) {
    const imgurUrl = await resolveImgurDownload(tabUrl, lowerCaseUrl);
    if (imgurUrl) {
      return imgurUrl;
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
