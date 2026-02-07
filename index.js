require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// 担当者マッピング（config/owners.json）
// ownerAliases: 苗字 or 短い名前 → フルネーム（1対1）
// ambiguousFamilyNames: 同姓が複数いる苗字 → [フルネーム, ...]。苗字だけ指定されたら必ず聞き返す
// ownerToTodoistId: フルネーム → Todoist ユーザー ID
let ownerAliases = {};
let ownerToSlackId = {};
let ownerToTodoistId = {};
let ambiguousFamilyNames = {};
try {
  const configPath = path.join(__dirname, 'config', 'owners.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  ownerAliases = config.ownerAliases || {};
  ownerToSlackId = config.ownerToSlackId || {};
  ownerToTodoistId = config.ownerToTodoistId || {};
  ambiguousFamilyNames = config.ambiguousFamilyNames || {};
} catch (e) {
  console.warn('config/owners.json が読めません（担当エイリアス・リマインド用）:', e.message);
}

// 期日っぽい表現を抽出（Todoistの due_string にそのまま渡せる形）
const DUE_PATTERNS = [
  /(明日|あす|あした)/i,
  /(あさって)/i,
  /(今日|きょう)/i,
  /(今週\s*月|今週\s*火|今週\s*水|今週\s*木|今週\s*金|今週\s*土|今週\s*日)/i,
  /(来週\s*月|来週\s*火|来週\s*水|来週\s*木|来週\s*金|来週\s*土|来週\s*日|来週月曜|来週火曜|来週水曜|来週木曜|来週金曜|来週土曜|来週日曜)/i,
  /(来週)/i,
  /(再来週)/i,
  /(月末|月初)/i,
  /(\d{1,2}\s*\/\s*\d{1,2}(?:\s*\/\s*\d{2,4})?)/,  // 2/10, 2/10/25
  /(\d{1,2}月\d{1,2}日?)/,  // 2月10日, 2月10
  /(tomorrow|today|next week|next monday|next tuesday|next wednesday|next thursday|next friday|next saturday|next sunday)/i,
];

function extractDueString(text) {
  const t = (text || '').trim();
  for (const re of DUE_PATTERNS) {
    const m = t.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

// 担当者名を解決。苗字だけの指定で同姓が複数いる場合は聞き返すため { ambiguous, familyName, options } を返す
function extractOwner(text) {
  const t = (text || '').trim();
  // 同姓が複数いる苗字：苗字だけ指定されていたら必ず聞き返す
  for (const [familyName, options] of Object.entries(ambiguousFamilyNames)) {
    if (!t.includes(familyName)) continue;
    const hasFullName = options.some((full) => t.includes(full));
    if (!hasFullName) {
      return { ambiguous: true, familyName, options };
    }
  }
  // "担当: 〇〇" 形式
  const descMatch = t.match(/担当\s*[：:]\s*(\S+)/);
  if (descMatch) {
    const name = descMatch[1];
    return { ownerName: ownerAliases[name] || name };
  }
  // 苗字・短い名前 → フルネーム（長い順でマッチ：石原采音  before 石原）
  const aliasKeys = Object.keys(ownerAliases).sort((a, b) => b.length - a.length);
  for (const alias of aliasKeys) {
    if (t.includes(alias)) return { ownerName: ownerAliases[alias] };
  }
  for (const fullName of Object.values(ownerAliases)) {
    if (t.includes(fullName)) return { ownerName: fullName };
  }
  return { ownerName: null };
}

// テキストから期日・担当・プロジェクトを除いた「タスク内容」と担当・プロジェクト情報を返す
function parseTaskText(text) {
  const raw = (text || '').trim();
  let rest = raw;
  const dueString = extractDueString(rest);
  const projectName = extractProjectName(rest);
  const ownerResult = extractOwner(rest);
  const ownerName = ownerResult.ownerName ?? null;
  const ownerAmbiguous = ownerResult.ambiguous ? { familyName: ownerResult.familyName, options: ownerResult.options } : null;

  // プロジェクト指定を除去
  if (projectName) {
    rest = rest.replace(new RegExp(`#${projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), ' ');
    rest = rest.replace(new RegExp(`プロジェクト\\s*[：:]\\s*${projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), ' ');
    rest = rest.replace(/\s+/g, ' ').trim();
  }
  // 期日を除去
  if (dueString) rest = rest.replace(dueString, ' ').replace(/\s+/g, ' ').trim();
  // 担当を除去（浦本が逆転転職→逆転転職 のように、苗字＋助詞をタスク内容から削る）
  const stripOwner = (name) => {
    if (!name) return;
    for (const particle of ['が', 'の', 'を', 'に', 'は']) rest = rest.replace(name + particle, ' ');
    rest = rest.replace(name, ' ');
    rest = rest.replace(/担当\s*[：:]?\s*/g, ' ').trim();
  };
  if (ownerAmbiguous) {
    stripOwner(ownerAmbiguous.familyName);
  } else if (ownerName) {
    stripOwner(ownerName);
    for (const [alias] of Object.entries(ownerAliases)) {
      if (ownerAliases[alias] === ownerName) stripOwner(alias);
    }
  }
  rest = rest.replace(/\s+/g, ' ').trim();
  const content = rest || '（Slackから追加）';

  return { content, dueString, ownerName, ownerAmbiguous, projectName };
}

// Slack リクエスト検証（署名シークレット）
function verifySlackRequest(rawBody, signature, timestamp) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return true; // 未設定の場合は検証スキップ（開発用）

  if (!signature || !signature.startsWith('v0=')) return false;
  if (!timestamp) return false;

  // タイムスタンプチェック（5分以内のリクエストのみ受け付ける）
  const currentTime = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTime - timestamp) > 60 * 5) {
    console.warn('Request timestamp is too old');
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const mySig = 'v0=' + crypto
    .createHmac('sha256', signingSecret)
    .update(sigBasestring)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(mySig));
}

// Todoist のプロジェクト一覧を取得（簡易キャッシュ）
let projectsCache = null;
let projectsCacheAt = 0;
const PROJECTS_CACHE_MS = 5 * 60 * 1000;

async function getTodoistProjects() {
  if (projectsCache && Date.now() - projectsCacheAt < PROJECTS_CACHE_MS) return projectsCache;
  const token = process.env.TODOIST_TOKEN;
  if (!token) return [];
  const res = await fetch('https://api.todoist.com/rest/v2/projects', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return [];
  projectsCache = await res.json();
  projectsCacheAt = Date.now();
  return projectsCache;
}

// プロジェクト名を解決（#名前 or プロジェクト:名前 から project_id を返す）
async function resolveProjectId(projectName) {
  if (!projectName || !projectName.trim()) return null;
  const name = projectName.trim();
  const projects = await getTodoistProjects();
  console.log(`[DEBUG] Searching for project: "${name}"`);
  console.log(`[DEBUG] Available projects:`, projects.map(p => p.name));
  const match = projects.find((p) => p.name === name || p.name.includes(name) || name.includes(p.name));
  console.log(`[DEBUG] Match found:`, match ? match.name : 'none');
  return match ? match.id : null;
}

// テキストからプロジェクト指定を抽出（#逆転転職, プロジェクト:逆転転職, P:逆転転職）
function extractProjectName(text) {
  const t = (text || '').trim();
  const hashMatch = t.match(/#([^\s#]+)/);
  if (hashMatch) return hashMatch[1];
  const projMatch = t.match(/プロジェクト\s*[：:]\s*(\S+)/);
  if (projMatch) return projMatch[1];
  const pMatch = t.match(/\bP\s*[：:]\s*(\S+)/);
  if (pMatch) return pMatch[1];
  return null;
}

// 担当者名から Todoist ユーザー ID を動的に取得（「ID取得用(編集しないで)」プロジェクトから）
let userIdCache = null;
let userIdCacheAt = 0;
const USER_ID_CACHE_MS = 10 * 60 * 1000; // 10分キャッシュ

async function getUserIdByName(ownerName) {
  if (!ownerName) return null;

  // キャッシュをチェック
  if (userIdCache && Date.now() - userIdCacheAt < USER_ID_CACHE_MS) {
    return userIdCache[ownerName] || null;
  }

  const token = process.env.TODOIST_TOKEN;
  if (!token) return null;

  try {
    // 「winova_slack✖️todoist」プロジェクト内の「ID取得用」タスクを検索
    const projects = await getTodoistProjects();
    const targetProject = projects.find(p => p.name === 'winova_slack✖️todoist');

    if (!targetProject) {
      console.warn('[WARN] winova_slack✖️todoist プロジェクトが見つかりません');
      return null;
    }

    // プロジェクト内のタスクを取得
    const tasksRes = await fetch(`https://api.todoist.com/rest/v2/tasks?project_id=${targetProject.id}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!tasksRes.ok) return null;

    const tasks = await tasksRes.json();
    const idTask = tasks.find(t => t.content.includes('ID取得'));

    if (!idTask) {
      console.warn('[WARN] ID取得用のタスクが見つかりません');
      return null;
    }

    // タスクのコメントを取得
    const commentsRes = await fetch(`https://api.todoist.com/rest/v2/comments?task_id=${idTask.id}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!commentsRes.ok) return null;

    const comments = await commentsRes.json();
    if (comments.length === 0) {
      console.warn('[WARN] ID取得用タスクにコメントがありません');
      return null;
    }

    // コメントからユーザー名と ID のマッピングを作成
    const userMapping = {};
    comments.forEach(comment => {
      const content = comment.content || '';
      // [名前](todoist-mention://ID) の形式をパース
      const mentionRegex = /\[([^\]]+)\]\(todoist-mention:\/\/(\d+)\)/g;
      let match;
      while ((match = mentionRegex.exec(content)) !== null) {
        const name = match[1];
        const id = match[2];
        userMapping[name] = id;

        // 名前のバリエーションも登録（「谷田倖輝/koki.yata」→「谷田倖輝」）
        const simpleName = name.split('/')[0].trim();
        if (simpleName !== name) {
          userMapping[simpleName] = id;
        }
      }
    });

    // キャッシュを更新
    userIdCache = userMapping;
    userIdCacheAt = Date.now();

    console.log('[DEBUG] User ID mapping:', userMapping);

    return userMapping[ownerName] || null;

  } catch (error) {
    console.error('[ERROR] Failed to fetch user IDs:', error.message);
    return null;
  }
}


// Todoist にタスクを作成
async function createTodoistTask(content, options = {}) {
  const token = process.env.TODOIST_TOKEN;
  if (!token) throw new Error('TODOIST_TOKEN が設定されていません');

  const body = {
    content: (content && content.trim()) ? content.trim() : '（Slackから追加）',
    ...(options.project_id && { project_id: options.project_id }),
    ...(options.due_string && { due_string: options.due_string, due_lang: 'ja' }),
    ...(options.assignee_id && { assignee_id: options.assignee_id }),
    ...(options.description && { description: options.description }),
  };

  console.log('[DEBUG] Creating Todoist task with body:', JSON.stringify(body, null, 2));

  const res = await fetch('https://api.todoist.com/rest/v2/tasks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Todoist API エラー: ${res.status} ${err}`);
  }

  return res.json();
}

// ★ スラッシュコマンドは body パース前に処理（生bodyで署名検証するため）
app.post('/slack/command', (req, res, next) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks).toString('utf8');
    next();
  });
}, async (req, res) => {
  const rawBody = req.rawBody;
  const signature = req.headers['x-slack-signature'];
  const timestamp = req.headers['x-slack-request-timestamp'];

  if (process.env.SLACK_SIGNING_SECRET && !verifySlackRequest(rawBody, signature, timestamp)) {
    console.error('Signature verification failed');
    return res.status(401).send('Invalid signature');
  }

  const params = new URLSearchParams(rawBody);
  const text = params.get('text') || '';
  const responseUrl = params.get('response_url');

  // Slackは3秒以内に何か返す必要があるので、先に「処理中」で200を返す
  res.status(200).json({
    response_type: 'ephemeral',
    text: 'Todoistに追加しています…',
  });

  const sendToSlack = (payload) => {
    if (responseUrl) {
      fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch((e) => console.error('response_url error', e));
    }
  };

  const { content, dueString, ownerName, ownerAmbiguous, projectName } = parseTaskText(text);
  console.log(`[DEBUG] Parsed text: "${text}"`);
  console.log(`[DEBUG] content: "${content}", dueString: "${dueString}", ownerName: "${ownerName}", projectName: "${projectName}"`);

  // 期日がないとタスク化しない
  if (!dueString) {
    sendToSlack({
      response_type: 'ephemeral',
      text: '❌ 期日を書いてもらえないとタスク化できません。\n例: `/todoist 資料作成 明日 中村` または `/todoist レポート提出 来週金曜 浦本`',
    });
    return;
  }

  // 同姓が複数いる場合（例: 石原）は苗字だけだと必ず聞き返す
  if (ownerAmbiguous) {
    const names = ownerAmbiguous.options.map((n) => `${n}さん`).join('と');
    sendToSlack({
      response_type: 'ephemeral',
      text: `❌ 「${ownerAmbiguous.familyName}」は${names}がいます。どちらに振りますか？\nフルネームで指定してください。例: \`/todoist ${content} ${dueString} ${ownerAmbiguous.options[0]}\``,
    });
    return;
  }

  try {
    // プロジェクトの決定: 明示的な指定がなければ winova_slack✖️todoist を使用
    let finalProjectName = projectName;
    if (!finalProjectName) {
      finalProjectName = 'winova_slack✖️todoist';
    }
    console.log(`[DEBUG] Using project: ${finalProjectName}`);

    const projectId = finalProjectName ? await resolveProjectId(finalProjectName) : null;
    console.log(`[DEBUG] finalProjectName: ${finalProjectName}, projectId: ${projectId}`);

    // 担当者の Todoist ID を動的に取得
    const assigneeId = ownerName ? await getUserIdByName(ownerName) : null;
    console.log(`[DEBUG] ownerName: ${ownerName}, assigneeId: ${assigneeId}`);

    const task = await createTodoistTask(content, {
      due_string: dueString,
      due_lang: 'ja',
      ...(projectId && { project_id: projectId }),
      ...(assigneeId && { assignee_id: assigneeId }),
      // assignee_id がない場合は description にフォールバック
      ...(!assigneeId && ownerName && { description: `担当: ${ownerName}` }),
    });

    let msg = `✅ Todoistにタスクを追加しました: *${task.content}*\n期日: ${dueString}`;
    if (ownerName) msg += `\n担当: ${ownerName}`;
    if (finalProjectName) msg += `\nプロジェクト: ${finalProjectName}`;
    if (task.url) msg += `\n<${task.url}|Todoistで開く>`;
    sendToSlack({ response_type: 'ephemeral', text: msg });
  } catch (err) {
    console.error(err);
    sendToSlack({
      response_type: 'ephemeral',
      text: `❌ 追加に失敗しました: ${err.message}`,
    });
  }
});

// その他のルート用
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ヘルスチェック（ngrokなどで動作確認用）
app.get('/', (req, res) => {
  res.send('Slack-Todoist連携サーバー稼働中。POST /slack/command にスラッシュコマンドを送信してください。');
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  if (!process.env.TODOIST_TOKEN) console.warn('警告: TODOIST_TOKEN が未設定です');
  if (!process.env.SLACK_SIGNING_SECRET) console.warn('警告: SLACK_SIGNING_SECRET が未設定です（本番では設定を推奨）');
});
