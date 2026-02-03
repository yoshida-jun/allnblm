// バックグラウンドサービスワーカー
// NotebookLM内部APIを直接叩いてソースを登録

const NOTEBOOKLM_URL = 'https://notebooklm.google.com/';
const BATCHEXECUTE_URL = 'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute';

const RPCMethod = {
  CREATE_NOTEBOOK: 'CCqFvf',
  GET_NOTEBOOK: 'rLM1Ne',
  ADD_SOURCE: 'izAoDd',
  CREATE_ARTIFACT: 'R7cb6c',
};

// アーティファクトタイプコード
const ArtifactType = {
  AUDIO: 1,           // 音声解説
  INFOGRAPHIC: 7,     // インフォグラフィック
};

// 設定
const CONFIG = {
  CONCURRENCY_LIMIT: 3,      // 同時リクエスト数
  RETRY_ATTEMPTS: 5,         // ソースID取得のリトライ回数
  RETRY_DELAY: 2000,         // リトライ間隔(ms)
  REQUEST_DELAY: 500,        // リクエスト間の遅延(ms)
};

// 並列処理を制限して実行
async function runWithConcurrencyLimit(tasks, limit) {
  const results = [];
  const executing = new Set();

  for (const task of tasks) {
    const promise = task().then(result => {
      executing.delete(promise);
      return { success: true, result };
    }).catch(error => {
      executing.delete(promise);
      return { success: false, error };
    });

    executing.add(promise);
    results.push(promise);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

// NotebookLMページからCSRFトークンを取得
async function getCSRFToken() {
  try {
    const response = await fetch(NOTEBOOKLM_URL, { credentials: 'include' });
    if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);

    const html = await response.text();
    const csrfMatch = html.match(/"SNlM0e":"([^"]+)"/);
    const sessionMatch = html.match(/"FdrFJe":"([^"]+)"/);

    return {
      csrfToken: csrfMatch ? csrfMatch[1] : null,
      sessionId: sessionMatch ? sessionMatch[1] : null
    };
  } catch (error) {
    console.error('[YT2NLM] Failed to get CSRF token:', error);
    return { csrfToken: null, sessionId: null };
  }
}

// RPCリクエストをエンコード
function encodeRPCRequest(method, params) {
  const innerArray = [[method, JSON.stringify(params), null, 'generic']];
  return `f.req=${encodeURIComponent(JSON.stringify([innerArray]))}`;
}

// RPCレスポンスをデコード
function decodeRPCResponse(text) {
  try {
    const cleanText = text.replace(/^\)\]\}'\n/, '');
    const lines = cleanText.split('\n');
    for (const line of lines) {
      if (line.startsWith('[')) {
        try {
          const parsed = JSON.parse(line);
          if (parsed[0]?.[2]) {
            return JSON.parse(parsed[0][2]);
          }
        } catch (e) {}
      }
    }
  } catch (e) {
    console.error('[YT2NLM] Decode error:', e);
  }
  return null;
}

// RPCコール実行
async function rpcCall(method, params, csrfToken, sessionId) {
  const url = `${BATCHEXECUTE_URL}?rpcids=${method}&source-path=/&f.sid=${sessionId || ''}&rt=c`;
  const body = encodeRPCRequest(method, params) + `&at=${encodeURIComponent(csrfToken)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
    credentials: 'include',
  });

  if (!response.ok) throw new Error(`RPC failed: ${response.status}`);
  return decodeRPCResponse(await response.text());
}

// ノートブック作成
async function createNotebook(title, csrfToken, sessionId) {
  const params = [title, null, null, [2], [1]];
  const result = await rpcCall(RPCMethod.CREATE_NOTEBOOK, params, csrfToken, sessionId);
  console.log('[YT2NLM] Create notebook result:', result);

  if (result?.[2] && typeof result[2] === 'string') return result[2];

  if (Array.isArray(result)) {
    for (const item of result) {
      if (typeof item === 'string' && item.length > 10 && !item.includes(' ')) {
        return item;
      }
    }
  }
  throw new Error('Failed to extract notebook ID');
}

// ノートブック情報を取得してソースIDを抽出
async function getSourceIds(notebookId, csrfToken, sessionId) {
  const params = [notebookId, null, [2], null, 0];
  const result = await rpcCall(RPCMethod.GET_NOTEBOOK, params, csrfToken, sessionId);
  console.log('[YT2NLM] Get notebook result:', JSON.stringify(result).substring(0, 500));

  const sourceIds = [];

  // ソースIDを再帰的に探す
  function findSourceIds(obj) {
    if (!obj) return;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        // ソースIDは通常長い文字列
        if (typeof item === 'string' && item.length > 20 && !item.includes(' ') && !item.startsWith('http')) {
          if (!sourceIds.includes(item) && item !== notebookId) {
            sourceIds.push(item);
          }
        }
        findSourceIds(item);
      }
    }
  }

  findSourceIds(result);
  console.log('[YT2NLM] Found source IDs:', sourceIds);
  return sourceIds;
}

// ソースIDを期待数になるまでポーリング
async function waitForSourceIds(notebookId, expectedCount, csrfToken, sessionId) {
  for (let i = 0; i < CONFIG.RETRY_ATTEMPTS; i++) {
    const sourceIds = await getSourceIds(notebookId, csrfToken, sessionId);
    console.log(`[YT2NLM] Polling ${i + 1}/${CONFIG.RETRY_ATTEMPTS}: found ${sourceIds.length}/${expectedCount} sources`);

    if (sourceIds.length >= expectedCount) {
      return sourceIds;
    }

    await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY));
  }

  // 最終試行
  return await getSourceIds(notebookId, csrfToken, sessionId);
}

// YouTubeソース追加
async function addYouTubeSource(notebookId, url, csrfToken, sessionId) {
  const params = [
    [[null, null, null, null, null, null, null, [url], null, null, 1]],
    notebookId,
    [2],
    [1, null, null, null, null, null, null, null, null, null, [1]]
  ];
  return await rpcCall(RPCMethod.ADD_SOURCE, params, csrfToken, sessionId);
}

// 音声解説を生成
async function createAudioOverview(notebookId, sourceIds, csrfToken, sessionId) {
  console.log('[YT2NLM] Creating audio overview...');

  const sourceIdsTriple = sourceIds.map(sid => [[[sid]]]);
  const sourceIdsDouble = sourceIds.map(sid => [[sid]]);

  const params = [
    [2],
    notebookId,
    [
      null, null,
      ArtifactType.AUDIO,
      sourceIdsTriple,
      null, null,
      [
        null,
        [
          null,        // instructions
          1,           // length (1=short, 2=medium, 3=long)
          null,
          sourceIdsDouble,
          'ja',        // 日本語
          null,
          1,           // format
        ],
      ],
    ],
  ];

  return await rpcCall(RPCMethod.CREATE_ARTIFACT, params, csrfToken, sessionId);
}

// インフォグラフィックを生成
async function createInfographic(notebookId, sourceIds, csrfToken, sessionId) {
  console.log('[YT2NLM] Creating infographic...');

  const sourceIdsTriple = sourceIds.map(sid => [[[sid]]]);

  const params = [
    [2],
    notebookId,
    [
      null, null,
      ArtifactType.INFOGRAPHIC,
      sourceIdsTriple,
      null, null, null, null, null, null, null, null, null, null,
      [[null, 'ja', null, 1, 2]],  // instructions, language, orientation, detail
    ],
  ];

  return await rpcCall(RPCMethod.CREATE_ARTIFACT, params, csrfToken, sessionId);
}

// NotebookLMタブに通知を送信
async function notifyTab(notebookId, message, type = 'info') {
  try {
    const tabs = await chrome.tabs.query({ url: `https://notebooklm.google.com/notebook/${notebookId}*` });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { action: 'showNotification', message, type }).catch(() => {});
    }
  } catch (e) {
    console.log('[YT2NLM] Could not notify tab:', e.message);
  }
}

// メイン処理: YouTubeをNotebookLMに登録
async function registerToNotebookLM(urls) {
  console.log('[YT2NLM] Starting registration for', urls.length, 'URLs');

  const { csrfToken, sessionId } = await getCSRFToken();
  if (!csrfToken) {
    console.log('[YT2NLM] CSRF token not found');
    return { success: false, needsAuth: true };
  }

  console.log('[YT2NLM] CSRF token acquired');

  // ノートブック作成
  const title = `YouTube動画 (${new Date().toLocaleDateString('ja-JP')})`;
  const notebookId = await createNotebook(title, csrfToken, sessionId);
  console.log('[YT2NLM] Created notebook:', notebookId);

  // ページを開く
  chrome.tabs.create({
    url: `https://notebooklm.google.com/notebook/${notebookId}`
  });

  // ソース追加→完了後にアーティファクト生成（バックグラウンド実行）
  (async () => {
    try {
      // レート制限付きでソースを追加
      const tasks = urls.map(url => async () => {
        await addYouTubeSource(notebookId, url, csrfToken, sessionId);
        console.log('[YT2NLM] Added:', url);
        await new Promise(r => setTimeout(r, CONFIG.REQUEST_DELAY));
        return url;
      });

      const results = await runWithConcurrencyLimit(tasks, CONFIG.CONCURRENCY_LIMIT);
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      console.log(`[YT2NLM] Sources added: ${successCount} success, ${failCount} failed`);
      notifyTab(notebookId, `📥 ${successCount}件のソースを追加中...`, 'info');

      // ポーリングでソースIDを取得
      const sourceIds = await waitForSourceIds(notebookId, successCount, csrfToken, sessionId);
      console.log(`[YT2NLM] Found ${sourceIds.length} source IDs`);

      if (sourceIds.length > 0) {
        notifyTab(notebookId, '🎙️ 音声解説を生成中...', 'info');

        // 音声解説とインフォグラフィックを並列生成
        const [audioResult, infoResult] = await Promise.allSettled([
          createAudioOverview(notebookId, sourceIds, csrfToken, sessionId),
          createInfographic(notebookId, sourceIds, csrfToken, sessionId),
        ]);

        const artifacts = [];
        if (audioResult.status === 'fulfilled') artifacts.push('音声解説');
        if (infoResult.status === 'fulfilled') artifacts.push('インフォグラフィック');

        if (artifacts.length > 0) {
          notifyTab(notebookId, `✅ 完了: ${artifacts.join('・')}を生成しました`, 'success');
        } else {
          notifyTab(notebookId, '⚠️ アーティファクトの生成に失敗しました', 'warning');
        }

        console.log('[YT2NLM] All artifacts processed');
      } else {
        notifyTab(notebookId, '⚠️ ソースの処理中です。しばらくお待ちください', 'warning');
      }
    } catch (e) {
      console.error('[YT2NLM] Background process error:', e);
      notifyTab(notebookId, `❌ エラー: ${e.message}`, 'error');
    }
  })();

  return { success: true, notebookId };
}

// メッセージハンドラー
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'openNotebookLM') {
    handleOpenNotebookLM(message.urls).then(sendResponse);
    return true;
  }
});

// NotebookLMに登録
async function handleOpenNotebookLM(urls) {
  try {
    const result = await registerToNotebookLM(urls);

    if (result.success) {
      return { success: true, ...result };
    } else if (result.needsAuth) {
      await chrome.storage.local.set({ pendingUrls: urls, timestamp: Date.now() });
      await chrome.tabs.create({ url: 'https://notebooklm.google.com/' });
      return { success: false, needsAuth: true };
    }
  } catch (error) {
    console.error('[YT2NLM] Error:', error);
    await chrome.storage.local.set({ pendingUrls: urls, timestamp: Date.now() });
    await chrome.tabs.create({ url: 'https://notebooklm.google.com/' });
    return { success: false, error: error.message };
  }
}

// 拡張機能インストール時
chrome.runtime.onInstalled.addListener(() => {
  console.log('YouTube to NotebookLM extension installed');
});
