// NotebookLM用コンテンツスクリプト
// バックグラウンドからの通知表示 + フォールバック処理

(function() {
  'use strict';

  console.log('[YT2NLM] Content script loaded');

  let hideTimeout = null;

  // オーバーレイ表示
  function showOverlay(message, type = 'info', duration = 5000) {
    let overlay = document.getElementById('yt2nlm-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'yt2nlm-overlay';
      document.body.appendChild(overlay);
    }

    const colors = {
      info: '#2196F3',
      success: '#4caf50',
      error: '#f44336',
      warning: '#ff9800'
    };

    overlay.style.cssText = `
      position: fixed; top: 20px; right: 20px; padding: 16px 24px;
      background: ${colors[type] || colors.info}; color: white; border-radius: 12px;
      font-family: 'Google Sans', sans-serif; font-size: 14px;
      z-index: 999999; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      max-width: 400px; line-height: 1.5; white-space: pre-wrap;
      transition: opacity 0.3s ease;
    `;
    overlay.textContent = message;
    overlay.style.opacity = '1';

    // 前のタイマーをクリア
    if (hideTimeout) clearTimeout(hideTimeout);

    // 成功/エラー時は長めに表示
    const displayDuration = (type === 'success' || type === 'error') ? 8000 : duration;

    hideTimeout = setTimeout(() => {
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 300);
    }, displayDuration);
  }

  // バックグラウンドからのメッセージを受信
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'showNotification') {
      showOverlay(message.message, message.type);
      sendResponse({ received: true });
    }
    return true;
  });

  // フォールバック処理（認証が必要な場合）
  (async () => {
    const data = await chrome.storage.local.get(['pendingUrls', 'timestamp']);

    if (!data.pendingUrls || data.pendingUrls.length === 0) {
      return;
    }

    if (Date.now() - data.timestamp > 10 * 60 * 1000) {
      await chrome.storage.local.remove(['pendingUrls', 'timestamp']);
      return;
    }

    const urls = data.pendingUrls;

    showOverlay(
      `📋 ${urls.length}件のYouTube URLを\nクリップボードにコピーしました。\n\n「ソースを追加」→「YouTube」から\n貼り付けてください。`,
      'info',
      10000
    );

    try {
      await navigator.clipboard.writeText(urls.join('\n'));
    } catch (e) {
      console.error('[YT2NLM] Clipboard error:', e);
    }

    await chrome.storage.local.remove(['pendingUrls', 'timestamp']);
  })();

})();
