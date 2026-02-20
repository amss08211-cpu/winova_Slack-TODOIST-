require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// lib モジュール
const { openTaskModal, updateModalSections, postMessage } = require('./lib/slack');
const { getTodoistProjects, getSections, createTodoistTask, resolveProjectId, resolveSectionId } = require('./lib/todoist');

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
  const triggerId = params.get('trigger_id');
  const botToken = process.env.SLACK_BOT_TOKEN;

  // Modal を開く
  if (!botToken) {
    return res.status(200).json({
      response_type: 'ephemeral',
      text: '❌ SLACK_BOT_TOKEN が設定されていません。管理者に連絡してください。',
    });
  }

  if (!triggerId) {
    return res.status(200).json({
      response_type: 'ephemeral',
      text: '❌ trigger_id が取得できませんでした。',
    });
  }

  try {
    await openTaskModal(triggerId, botToken);
    // Modal を開いたら即座に 200 を返す（空レスポンス）
    return res.status(200).send('');
  } catch (err) {
    console.error(`[ERROR] Failed to open modal: ${err.message}`);
    return res.status(200).json({
      response_type: 'ephemeral',
      text: `❌ Modalを開けませんでした: ${err.message}`,
    });
  }
});

// その他のルート用
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// /slack/interactivity - Modal操作を処理
app.post('/slack/interactivity', async (req, res) => {
  try {
    const payload = JSON.parse(req.body.payload);
    const botToken = process.env.SLACK_BOT_TOKEN;

    console.log(`[DEBUG] Interactivity type: ${payload.type}`);

    // プロジェクト選択時 → セクション一覧を更新
    if (payload.type === 'block_actions') {
      const action = payload.actions?.[0];
      if (action?.action_id === 'project_select') {
        const projectId = action.selected_option?.value;
        console.log(`[DEBUG] Project selected: ${projectId}`);

        if (projectId && botToken) {
          await updateModalSections(
            payload.view.id,
            projectId,
            botToken,
            payload.view
          );
        }
      }
      return res.status(200).send('');
    }

    // Modal送信時 → タスク作成
    if (payload.type === 'view_submission' && payload.view?.callback_id === 'task_create_modal') {
      const values = payload.view.state.values;

      const content = values.task_content?.content_input?.value;
      const dueString = values.task_due?.due_input?.value || null;
      const projectId = values.task_project?.project_select?.selected_option?.value;
      const sectionId = values.task_section?.section_select?.selected_option?.value;
      const assignee = values.task_assignee?.assignee_input?.value || null;

      console.log(`[DEBUG] Creating task: ${content}, project: ${projectId}, section: ${sectionId}`);

      if (!content) {
        return res.status(200).json({
          response_action: 'errors',
          errors: { task_content: 'タスク内容を入力してください' }
        });
      }

      // バックグラウンドでタスク作成
      (async () => {
        try {
          const taskOptions = {
            ...(dueString && { due_string: dueString, due_lang: 'ja' }),
            ...(projectId && { project_id: projectId }),
            ...(sectionId && sectionId !== 'none' && { section_id: sectionId }),
            ...(assignee && { description: `担当: ${assignee}` })
          };

          const task = await createTodoistTask(content, taskOptions);

          // 結果を通知（DMまたはチャンネル）
          if (botToken && payload.user?.id) {
            let msg = `✅ Todoistにタスクを追加しました: *${task.content}*`;
            if (dueString) msg += `\n期日: ${dueString}`;
            if (assignee) msg += `\n担当: ${assignee}`;
            if (task.url) msg += `\n<${task.url}|Todoistで開く>`;

            await postMessage(payload.user.id, msg, botToken);
          }
        } catch (err) {
          console.error(`[ERROR] Task creation failed: ${err.message}`);
          if (botToken && payload.user?.id) {
            await postMessage(payload.user.id, `❌ タスク作成に失敗しました: ${err.message}`, botToken);
          }
        }
      })();

      // Modalを閉じる
      return res.status(200).json({ response_action: 'clear' });
    }

    res.status(200).send('');
  } catch (error) {
    console.error(`[ERROR] /slack/interactivity: ${error.message}`);
    res.status(200).send('');
  }
});

// ヘルスチェック(ngrokなどで動作確認用)
app.get('/', (req, res) => {
  const status = {
    status: 'running',
    timestamp: new Date().toISOString(),
    environment: {
      TODOIST_TOKEN: process.env.TODOIST_TOKEN ? '✅ Set' : '❌ Not set',
      SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET ? '✅ Set' : '❌ Not set',
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN ? '✅ Set' : '❌ Not set',
    }
  };

  res.json(status);
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  if (!process.env.TODOIST_TOKEN) console.warn('警告: TODOIST_TOKEN が未設定です');
  if (!process.env.SLACK_SIGNING_SECRET) console.warn('警告: SLACK_SIGNING_SECRET が未設定です（本番では設定を推奨）');
});
