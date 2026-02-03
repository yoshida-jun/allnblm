// エラー/ステータス表示用ヘルパー
function showStatus(message, isError = true) {
  const content = document.getElementById('content');
  content.innerHTML = `<div class="status ${isError ? 'error' : 'info'}">${message}</div>`;
}

// YouTube動画のURLを収集するスクリプト
const collectVideosScript = () => {
  const videos = new Map();

  // タイトル取得のヘルパー関数
  const extractTitle = (link, container) => {
    // 1. リンク自体のtitle属性（最も信頼性が高い）
    if (link.getAttribute('title')) {
      return link.getAttribute('title');
    }

    // 2. aria-label属性
    if (link.getAttribute('aria-label')) {
      const ariaLabel = link.getAttribute('aria-label');
      // "〇〇 by チャンネル名 X views Y ago Z minutes" のようなフォーマットから抽出
      const match = ariaLabel.match(/^(.+?)\s+by\s+/);
      if (match) return match[1];
      return ariaLabel.split(/\d+\s*(view|再生)/i)[0].trim();
    }

    // 3. コンテナ内のタイトル要素
    if (container) {
      // さまざまなセレクターを試す
      const titleSelectors = [
        '#video-title',
        '#video-title-link',
        'a#video-title',
        '[id="video-title"]',
        'yt-formatted-string#video-title',
        '.title',
        'h3 a',
        'span#video-title',
        '[class*="title"]'
      ];

      for (const selector of titleSelectors) {
        const el = container.querySelector(selector);
        if (el) {
          const text = el.getAttribute('title') || el.textContent?.trim();
          if (text && text.length > 0 && !text.match(/^\d+$/)) {
            return text;
          }
        }
      }
    }

    // 4. リンク内のテキスト
    const linkText = link.textContent?.trim();
    if (linkText && linkText.length > 3 && !linkText.match(/^\d+:\d+$/)) {
      return linkText;
    }

    // 5. 親要素を遡ってタイトルを探す
    let parent = link.parentElement;
    for (let i = 0; i < 5 && parent; i++) {
      const titleEl = parent.querySelector('[title]');
      if (titleEl && titleEl.getAttribute('title')) {
        return titleEl.getAttribute('title');
      }
      parent = parent.parentElement;
    }

    return null;
  };

  // 日付テキストをパースしてDateオブジェクトに変換
  const parseDateText = (text) => {
    if (!text) return null;
    const now = new Date();

    // 「X時間前」「X日前」「X週間前」「X か月前」「X年前」などをパース
    const patterns = [
      { regex: /(\d+)\s*(秒|second)/i, unit: 'seconds' },
      { regex: /(\d+)\s*(分|minute)/i, unit: 'minutes' },
      { regex: /(\d+)\s*(時間|hour)/i, unit: 'hours' },
      { regex: /(\d+)\s*(日|day)/i, unit: 'days' },
      { regex: /(\d+)\s*(週間?|week)/i, unit: 'weeks' },
      { regex: /(\d+)\s*(か月|ヶ月|カ月|month)/i, unit: 'months' },
      { regex: /(\d+)\s*(年|year)/i, unit: 'years' },
    ];

    for (const { regex, unit } of patterns) {
      const match = text.match(regex);
      if (match) {
        const value = parseInt(match[1], 10);
        const date = new Date(now);
        switch (unit) {
          case 'seconds': date.setSeconds(date.getSeconds() - value); break;
          case 'minutes': date.setMinutes(date.getMinutes() - value); break;
          case 'hours': date.setHours(date.getHours() - value); break;
          case 'days': date.setDate(date.getDate() - value); break;
          case 'weeks': date.setDate(date.getDate() - value * 7); break;
          case 'months': date.setMonth(date.getMonth() - value); break;
          case 'years': date.setFullYear(date.getFullYear() - value); break;
        }
        return date.getTime();
      }
    }
    return null;
  };

  // 日付テキストを抽出
  const extractDate = (container) => {
    if (!container) return null;

    // メタデータ行から日付を探す
    const metadataSelectors = [
      '#metadata-line span',
      '.ytd-video-meta-block span',
      '#metadata span',
      '.metadata-line span',
      '[class*="metadata"] span',
    ];

    for (const selector of metadataSelectors) {
      const spans = container.querySelectorAll(selector);
      for (const span of spans) {
        const text = span.textContent?.trim() || '';
        // 「前」「ago」を含むテキストを探す
        if (text.match(/(前|ago)/i)) {
          const parsed = parseDateText(text);
          if (parsed) return parsed;
        }
      }
    }
    return null;
  };

  // 現在視聴中の動画
  const currentUrl = window.location.href;
  if (currentUrl.includes('/watch?v=')) {
    const videoId = new URL(currentUrl).searchParams.get('v');
    if (videoId) {
      // 現在の動画タイトルを複数の方法で取得
      let title = document.querySelector('h1.ytd-video-primary-info-renderer yt-formatted-string')?.textContent?.trim()
        || document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim()
        || document.querySelector('h1.ytd-video-primary-info-renderer')?.textContent?.trim()
        || document.querySelector('h1.ytd-watch-metadata')?.textContent?.trim()
        || document.querySelector('#title h1')?.textContent?.trim()
        || document.querySelector('meta[name="title"]')?.getAttribute('content')
        || document.title.replace(' - YouTube', '');

      // 視聴ページの投稿日を取得
      const dateText = document.querySelector('#info-strings yt-formatted-string')?.textContent?.trim();
      const publishDate = parseDateText(dateText);

      videos.set(videoId, { id: videoId, title, url: `https://www.youtube.com/watch?v=${videoId}`, publishDate });
    }
  }

  // ページ内の全動画リンクを収集
  const videoLinks = document.querySelectorAll('a[href*="/watch?v="]');
  videoLinks.forEach(link => {
    try {
      const url = new URL(link.href, window.location.origin);
      const videoId = url.searchParams.get('v');
      if (videoId && !videos.has(videoId)) {
        // コンテナを探す
        const containerSelectors = [
          'ytd-video-renderer',
          'ytd-compact-video-renderer',
          'ytd-grid-video-renderer',
          'ytd-rich-item-renderer',
          'ytd-playlist-video-renderer',
          'ytd-playlist-panel-video-renderer',
          'ytd-reel-item-renderer',
          '[class*="video-renderer"]'
        ];

        let container = null;
        for (const selector of containerSelectors) {
          container = link.closest(selector);
          if (container) break;
        }

        let title = extractTitle(link, container);

        // タイトルが取得できなかった場合のフォールバック
        if (!title || title.length < 2) {
          title = `YouTube動画 (${videoId.substring(0, 6)}...)`;
        }

        // タイトルをクリーンアップ
        title = title.split('\n')[0].trim();
        // 再生回数や時間の情報を除去
        title = title.replace(/\s*\d+[KMB]?\s*(views?|回視聴|再生).*$/i, '').trim();
        if (title.length > 80) {
          title = title.substring(0, 77) + '...';
        }

        // 日付情報を取得
        const publishDate = extractDate(container);

        videos.set(videoId, { id: videoId, title, url: `https://www.youtube.com/watch?v=${videoId}`, publishDate });
      }
    } catch (e) {
      // URLパースエラーは無視
    }
  });

  return Array.from(videos.values());
};

// グローバルに全動画を保持（フィルター用）
let allVideos = [];

// 日付フィルターの定義
const DATE_FILTERS = {
  all: { label: 'すべて', days: null },
  today: { label: '今日', days: 1 },
  week: { label: '1週間', days: 7 },
  month: { label: '1か月', days: 30 },
  year: { label: '1年', days: 365 },
};

// フィルター適用
function applyFilters() {
  const keyword = document.getElementById('keywordFilter')?.value?.toLowerCase() || '';
  const dateFilter = document.getElementById('dateFilter')?.value || 'all';

  const now = Date.now();
  const filterDays = DATE_FILTERS[dateFilter]?.days;

  const filtered = allVideos.filter(video => {
    // キーワードフィルター
    if (keyword && !video.title.toLowerCase().includes(keyword)) {
      return false;
    }

    // 日付フィルター
    if (filterDays && video.publishDate) {
      const diffDays = (now - video.publishDate) / (1000 * 60 * 60 * 24);
      if (diffDays > filterDays) {
        return false;
      }
    }

    return true;
  });

  renderFilteredList(filtered);
}

// フィルター済みリストを描画
function renderFilteredList(videos) {
  const listContainer = document.getElementById('videoListContainer');
  const countDisplay = document.getElementById('filteredCount');

  if (countDisplay) {
    countDisplay.textContent = `${videos.length}/${allVideos.length}件`;
  }

  if (!listContainer) return;

  if (videos.length === 0) {
    listContainer.innerHTML = '<div class="no-results">該当する動画がありません</div>';
    return;
  }

  let html = '';
  videos.forEach((video, index) => {
    html += `
      <div class="video-item">
        <input type="checkbox" id="video-${index}" data-url="${video.url}" checked>
        <span class="video-title" data-url="${video.url}" title="${video.title}">${video.title}</span>
      </div>
    `;
  });

  listContainer.innerHTML = html;

  // タイトルクリックで動画ページを開く（バックグラウンドで開く）
  document.querySelectorAll('.video-title').forEach(title => {
    title.addEventListener('click', () => {
      chrome.tabs.create({ url: title.dataset.url, active: false });
    });
  });
}

// 動画リストを表示
function renderVideoList(videos) {
  allVideos = videos;

  if (videos.length === 0) {
    showStatus('YouTubeの動画が見つかりませんでした。<br>YouTubeページで使用してください。');
    return;
  }

  const content = document.getElementById('content');

  // 日付オプションを生成
  const dateOptions = Object.entries(DATE_FILTERS)
    .map(([value, { label }]) => `<option value="${value}">${label}</option>`)
    .join('');

  let html = `
    <div class="filter-section">
      <input type="text" id="keywordFilter" placeholder="🔍 キーワードで検索..." class="filter-input">
      <select id="dateFilter" class="filter-select">
        ${dateOptions}
      </select>
    </div>
    <div class="video-count">🎬 <span id="filteredCount">${videos.length}/${videos.length}件</span>の動画</div>
    <div class="select-all-row">
      <label>
        <input type="checkbox" id="selectAll" checked>
        すべて選択
      </label>
    </div>
    <div class="video-list" id="videoListContainer">
  `;

  videos.forEach((video, index) => {
    html += `
      <div class="video-item">
        <input type="checkbox" id="video-${index}" data-url="${video.url}" checked>
        <span class="video-title" data-url="${video.url}" title="${video.title}">${video.title}</span>
      </div>
    `;
  });

  html += `
    </div>
    <div class="button-group">
      <button class="btn-secondary" id="refreshBtn">更新</button>
      <button class="btn-primary" id="sendBtn">NotebookLMに登録</button>
    </div>
  `;

  content.innerHTML = html;

  // イベントリスナーを設定
  document.getElementById('selectAll').addEventListener('change', (e) => {
    const checkboxes = document.querySelectorAll('.video-item input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = e.target.checked);
  });

  // フィルターイベント
  document.getElementById('keywordFilter').addEventListener('input', applyFilters);
  document.getElementById('dateFilter').addEventListener('change', applyFilters);

  // タイトルクリックで動画ページを開く（バックグラウンドで開く）
  document.querySelectorAll('.video-title').forEach(title => {
    title.addEventListener('click', () => {
      chrome.tabs.create({ url: title.dataset.url, active: false });
    });
  });

  document.getElementById('refreshBtn').addEventListener('click', loadVideos);

  document.getElementById('sendBtn').addEventListener('click', sendToNotebookLM);
}

// 選択された動画URLを取得
function getSelectedUrls() {
  const checkboxes = document.querySelectorAll('.video-item input[type="checkbox"]:checked');
  return Array.from(checkboxes).map(cb => cb.dataset.url);
}

// NotebookLMに送信
async function sendToNotebookLM() {
  const urls = getSelectedUrls();

  if (urls.length === 0) {
    alert('動画を選択してください');
    return;
  }

  const sendBtn = document.getElementById('sendBtn');
  sendBtn.disabled = true;
  sendBtn.textContent = '送信中...';

  try {
    // URLをストレージに保存
    await chrome.storage.local.set({
      pendingUrls: urls,
      timestamp: Date.now()
    });

    // NotebookLMを開く
    await chrome.runtime.sendMessage({
      action: 'openNotebookLM',
      urls: urls
    });

    // ポップアップを閉じる
    window.close();
  } catch (error) {
    console.error('Error:', error);
    sendBtn.disabled = false;
    sendBtn.textContent = 'NotebookLMに登録';
    alert('エラーが発生しました: ' + error.message);
  }
}

// 動画を読み込む
async function loadVideos() {
  const content = document.getElementById('content');
  content.innerHTML = '<div class="loading">動画を検索中</div>';

  try {
    // 現在のタブを取得
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url?.includes('youtube.com')) {
      showStatus(`YouTubeページで使用してください。<br>現在のページ: ${tab.url?.substring(0, 50)}...`);
      return;
    }

    // コンテンツスクリプトを実行
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectVideosScript
    });

    const videos = results[0]?.result || [];
    renderVideoList(videos);
  } catch (error) {
    console.error('Error:', error);
    showStatus(`動画の取得に失敗しました。<br>ページを再読み込みしてお試しください。<br><small>${error.message}</small>`);
  }
}

// 初期化
document.addEventListener('DOMContentLoaded', loadVideos);
