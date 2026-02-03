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

// ノートブック設定パラメータ
const NotebookParams = {
  PROJECT_TYPE: [2],        // プロジェクトタイプ
  FEATURE_FLAGS: [1],       // 機能フラグ
};

// 音声解説パラメータ
const AudioParams = {
  LENGTH_SHORT: 1,
  LENGTH_MEDIUM: 2,
  LENGTH_LONG: 3,
  FORMAT_DEFAULT: 1,
  LANGUAGE_JA: 'ja',
};

// インフォグラフィックパラメータ
const InfographicParams = {
  LANGUAGE_JA: 'ja',
  ORIENTATION_DEFAULT: 1,
  DETAIL_LEVEL: 2,
};

// 設定
const CONFIG = {
  CONCURRENCY_LIMIT: 3,      // 同時リクエスト数
  RETRY_ATTEMPTS: 5,         // ソースID取得のリトライ回数
  RETRY_DELAY: 2000,         // リトライ間隔(ms)
  REQUEST_DELAY: 500,        // リクエスト間の遅延(ms)
  LOG_PREFIX: '[YT2NLM]',    // ログプレフィックス
};

// 統一されたログ関数
const log = {
  info: (...args) => console.log(CONFIG.LOG_PREFIX, ...args),
  error: (...args) => console.error(CONFIG.LOG_PREFIX, ...args),
  warn: (...args) => console.warn(CONFIG.LOG_PREFIX, ...args),
};

// 認証コンテキスト（csrfToken, sessionIdをまとめて管理）
class AuthContext {
  constructor(csrfToken, sessionId) {
    this.csrfToken = csrfToken;
    this.sessionId = sessionId;
  }

  isValid() {
    return !!this.csrfToken;
  }
}

// ソースID配列の変換ヘルパー
const SourceIdFormatter = {
  toTriple: (sourceIds) => sourceIds.map(sid => [[[sid]]]),
  toDouble: (sourceIds) => sourceIds.map(sid => [[sid]]),
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
    log.error('Failed to get CSRF token:', error);
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
        } catch (parseError) {
          // 各行のパースエラーは想定内（複数行のうち一部のみが有効なJSON）
          continue;
        }
      }
    }
  } catch (e) {
    log.error('Decode error:', e);
  }
  return null;
}

// RPCコール実行
async function rpcCall(method, params, auth) {
  const url = `${BATCHEXECUTE_URL}?rpcids=${method}&source-path=/&f.sid=${auth.sessionId || ''}&rt=c`;
  const body = encodeRPCRequest(method, params) + `&at=${encodeURIComponent(auth.csrfToken)}`;

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
async function createNotebook(title, auth) {
  const params = [title, null, null, NotebookParams.PROJECT_TYPE, NotebookParams.FEATURE_FLAGS];
  const result = await rpcCall(RPCMethod.CREATE_NOTEBOOK, params, auth);
  log.info('Create notebook result:', result);

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
async function getSourceIds(notebookId, auth) {
  const params = [notebookId, null, NotebookParams.PROJECT_TYPE, null, 0];
  const result = await rpcCall(RPCMethod.GET_NOTEBOOK, params, auth);
  log.info('Get notebook result:', JSON.stringify(result).substring(0, 500));

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
  log.info('Found source IDs:', sourceIds);
  return sourceIds;
}

// ソースIDを期待数になるまでポーリング
async function waitForSourceIds(notebookId, expectedCount, auth) {
  for (let i = 0; i < CONFIG.RETRY_ATTEMPTS; i++) {
    const sourceIds = await getSourceIds(notebookId, auth);
    log.info(`Polling ${i + 1}/${CONFIG.RETRY_ATTEMPTS}: found ${sourceIds.length}/${expectedCount} sources`);

    if (sourceIds.length >= expectedCount) {
      return sourceIds;
    }

    await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY));
  }

  // 最終試行
  return await getSourceIds(notebookId, auth);
}

// YouTubeソース追加
async function addYouTubeSource(notebookId, url, auth) {
  const params = [
    [[null, null, null, null, null, null, null, [url], null, null, 1]],
    notebookId,
    NotebookParams.PROJECT_TYPE,
    [1, null, null, null, null, null, null, null, null, null, NotebookParams.FEATURE_FLAGS]
  ];
  return await rpcCall(RPCMethod.ADD_SOURCE, params, auth);
}

// 音声解説を生成
async function createAudioOverview(notebookId, sourceIds, auth) {
  log.info('Creating audio overview...');

  const params = [
    NotebookParams.PROJECT_TYPE,
    notebookId,
    [
      null, null,
      ArtifactType.AUDIO,
      SourceIdFormatter.toTriple(sourceIds),
      null, null,
      [
        null,
        [
          null,
          AudioParams.LENGTH_SHORT,
          null,
          SourceIdFormatter.toDouble(sourceIds),
          AudioParams.LANGUAGE_JA,
          null,
          AudioParams.FORMAT_DEFAULT,
        ],
      ],
    ],
  ];

  return await rpcCall(RPCMethod.CREATE_ARTIFACT, params, auth);
}

// インフォグラフィックを生成
async function createInfographic(notebookId, sourceIds, auth) {
  log.info('Creating infographic...');

  const params = [
    NotebookParams.PROJECT_TYPE,
    notebookId,
    [
      null, null,
      ArtifactType.INFOGRAPHIC,
      SourceIdFormatter.toTriple(sourceIds),
      null, null, null, null, null, null, null, null, null, null,
      [[null, InfographicParams.LANGUAGE_JA, null, InfographicParams.ORIENTATION_DEFAULT, InfographicParams.DETAIL_LEVEL]],
    ],
  ];

  return await rpcCall(RPCMethod.CREATE_ARTIFACT, params, auth);
}

// NotebookLMタブに通知を送信
async function notifyTab(notebookId, message, type = 'info') {
  try {
    const tabs = await chrome.tabs.query({ url: `https://notebooklm.google.com/notebook/${notebookId}*` });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { action: 'showNotification', message, type }).catch(() => {});
    }
  } catch (e) {
    log.info('Could not notify tab:', e.message);
  }
}

// メイン処理: YouTubeをNotebookLMに登録
async function registerToNotebookLM(urls) {
  log.info('Starting registration for', urls.length, 'URLs');

  const { csrfToken, sessionId } = await getCSRFToken();
  const auth = new AuthContext(csrfToken, sessionId);

  if (!auth.isValid()) {
    log.info('CSRF token not found');
    return { success: false, needsAuth: true };
  }

  log.info('CSRF token acquired');

  // ノートブック作成
  const title = `YouTube動画 (${new Date().toLocaleDateString('ja-JP')})`;
  const notebookId = await createNotebook(title, auth);
  log.info('Created notebook:', notebookId);

  // ページを開く
  chrome.tabs.create({
    url: `https://notebooklm.google.com/notebook/${notebookId}`
  });

  // ソース追加→完了後にアーティファクト生成（バックグラウンド実行）
  (async () => {
    try {
      // レート制限付きでソースを追加
      const tasks = urls.map(url => async () => {
        await addYouTubeSource(notebookId, url, auth);
        log.info('Added:', url);
        await new Promise(r => setTimeout(r, CONFIG.REQUEST_DELAY));
        return url;
      });

      const results = await runWithConcurrencyLimit(tasks, CONFIG.CONCURRENCY_LIMIT);
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      log.info(`Sources added: ${successCount} success, ${failCount} failed`);
      notifyTab(notebookId, `📥 ${successCount}件のソースを追加中...`, 'info');

      // ポーリングでソースIDを取得
      const sourceIds = await waitForSourceIds(notebookId, successCount, auth);
      log.info(`Found ${sourceIds.length} source IDs`);

      if (sourceIds.length > 0) {
        notifyTab(notebookId, '🎙️ 音声解説を生成中...', 'info');

        // 音声解説とインフォグラフィックを並列生成
        const [audioResult, infoResult] = await Promise.allSettled([
          createAudioOverview(notebookId, sourceIds, auth),
          createInfographic(notebookId, sourceIds, auth),
        ]);

        const artifacts = [];
        if (audioResult.status === 'fulfilled') artifacts.push('音声解説');
        if (infoResult.status === 'fulfilled') artifacts.push('インフォグラフィック');

        if (artifacts.length > 0) {
          notifyTab(notebookId, `✅ 完了: ${artifacts.join('・')}を生成しました`, 'success');
        } else {
          notifyTab(notebookId, '⚠️ アーティファクトの生成に失敗しました', 'warning');
        }

        log.info('All artifacts processed');
      } else {
        notifyTab(notebookId, '⚠️ ソースの処理中です。しばらくお待ちください', 'warning');
      }
    } catch (e) {
      log.error('Background process error:', e);
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
    log.error('Error:', error);
    await chrome.storage.local.set({ pendingUrls: urls, timestamp: Date.now() });
    await chrome.tabs.create({ url: 'https://notebooklm.google.com/' });
    return { success: false, error: error.message };
  }
}

// 拡張機能インストール時
chrome.runtime.onInstalled.addListener(() => {
  log.info('Extension installed');
});
