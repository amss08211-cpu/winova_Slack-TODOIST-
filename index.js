require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// lib モジュール
const { openTaskModal, postMessage, getThreadMessages, formatThreadContent } = require('./lib/slack');
const { getTodoistProjects, getSections, createTodoistTask, updateTodoistTask, resolveProjectId, resolveSectionId } = require('./lib/todoist');
const { parseTaskWithAI } = require('./lib/ai');

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
    if (!req.body?.payload) {
      console.error(`[ERROR] No payload in request body`);
      return res.status(200).send('');
    }
    const payload = JSON.parse(req.body.payload);
    const botToken = process.env.SLACK_BOT_TOKEN;

    // external_select の候補を返す
    if (payload.type === 'block_suggestion') {
      const actionId = payload.action_id;
      const query = (payload.value || '').trim();
      const queryLower = query.toLowerCase();

      // プロジェクト候補
      if (actionId === 'project_select') {
        const projects = await getTodoistProjects();

        // アーカイブ・削除済み・オンボーディング・インボックス・不要プロジェクトを除外
        const excludeNames = ['はじめよう', 'インボックス','てすと用３', 'テスト用３'];
        const activeProjects = projects.filter(p =>
          !p.is_archived &&
          !p.is_deleted &&
          !p.is_inbox_project &&
          !excludeNames.some(name => p.name.includes(name))
        );
        const sortedProjects = [...activeProjects].sort((a, b) => {
          if (a.folder_id !== b.folder_id) {
            if (!a.folder_id) return 1;
            if (!b.folder_id) return -1;
            return String(a.folder_id).localeCompare(String(b.folder_id));
          }
          return (a.child_order || 0) - (b.child_order || 0);
        });

        const options = sortedProjects
          .filter(p => !query || p.name.toLowerCase().includes(queryLower))
          .slice(0, 100)
          .map(p => ({
            text: { type: 'plain_text', text: p.name },
            value: p.id
          }));

        return res.status(200).json({ options });
      }

      // セクション候補（選択されたプロジェクトのセクションのみ表示）
      if (actionId === 'section_select') {
        // private_metadataから選択されたプロジェクトIDを取得
        let projectIds = [];
        if (payload.view?.private_metadata) {
          try {
            const meta = JSON.parse(payload.view.private_metadata);
            projectIds = meta.projects ? meta.projects.split(',') : [];
          } catch {
            // 旧形式の場合
            const metadata = payload.view.private_metadata;
            projectIds = metadata.startsWith('projects:') ? metadata.substring(9).split(',') : [];
          }
        }

        let options = [
          { text: { type: 'plain_text', text: '（なし）' }, value: 'none' }
        ];

        if (projectIds.length > 0) {
          const projects = await getTodoistProjects();

          // 選択されたプロジェクトのみ処理
          for (const projectId of projectIds) {
            const proj = projects.find(p => p.id === projectId);
            if (!proj) continue;

            const sections = await getSections(projectId);
            const sortedSections = [...sections].sort((a, b) => (a.section_order || a.order || 0) - (b.section_order || b.order || 0));
            const filtered = sortedSections
              .filter(s => !query || s.name.toLowerCase().includes(queryLower))
              .map(s => ({
                text: { type: 'plain_text', text: projectIds.length > 1 ? `${s.name} (${proj.name})` : s.name },
                value: s.id
              }));
            options = options.concat(filtered);
          }
        }

        return res.status(200).json({ options: options.slice(0, 100) });
      }

      return res.status(200).json({ options: [] });
    }

    // プロジェクト選択時 → private_metadataに選択されたプロジェクトIDを保存
    if (payload.type === 'block_actions') {
      const action = payload.actions?.[0];

      // AI要約ボタンクリック時
      if (action?.action_id === 'ai_summarize') {
        const values = payload.view.state.values;
        const sourceText = values.ai_source?.ai_source_input?.value || '';

        if (!sourceText.trim()) {
          // 要約元テキストが空の場合は何もしない
          return res.status(200).send('');
        }

        try {
          // AIで要約
          const taskInfo = await parseTaskWithAI(sourceText);

          // 現在のブロックをコピーして、値を更新
          const updatedBlocks = payload.view.blocks.map(block => {
            if (block.block_id === 'task_content') {
              return {
                ...block,
                element: {
                  ...block.element,
                  initial_value: taskInfo.title || ''
                }
              };
            }
            if (block.block_id === 'task_description') {
              return {
                ...block,
                element: {
                  ...block.element,
                  initial_value: taskInfo.description || ''
                }
              };
            }
            if (block.block_id === 'task_due') {
              return {
                ...block,
                element: {
                  ...block.element,
                  initial_value: taskInfo.due_date || ''
                }
              };
            }
            return block;
          });

          // 既存のmetadataをパースして、AI結果を追加
          let metadata = {};
          if (payload.view.private_metadata) {
            try {
              metadata = JSON.parse(payload.view.private_metadata);
            } catch {
              // 旧形式（projects:xxx）の場合
              if (payload.view.private_metadata.startsWith('projects:')) {
                metadata = { projects: payload.view.private_metadata.substring(9) };
              }
            }
          }
          metadata.ai_title = taskInfo.title || '';
          metadata.ai_description = taskInfo.description || '';
          metadata.ai_due = taskInfo.due_date || '';
          metadata.ai_source = sourceText; // 元テキストを保存

          // モーダルを更新
          await fetch('https://slack.com/api/views.update', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${botToken}`
            },
            body: JSON.stringify({
              view_id: payload.view.id,
              view: {
                type: 'modal',
                callback_id: payload.view.callback_id,
                private_metadata: JSON.stringify(metadata),
                title: payload.view.title,
                submit: payload.view.submit,
                close: payload.view.close,
                blocks: updatedBlocks
              }
            })
          });
        } catch (err) {
          console.error(`[ERROR] AI要約エラー: ${err.message}`);
        }

        return res.status(200).send('');
      }

      if (action?.action_id === 'project_select') {
        const selectedOptions = action.selected_options || [];
        const projectIds = selectedOptions.map(opt => opt.value).join(',');

        // private_metadataにプロジェクトIDを保存してモーダル更新
        if (botToken) {
          // 既存のmetadataを保持しつつprojectsを更新
          let metadata = {};
          if (payload.view.private_metadata) {
            try {
              metadata = JSON.parse(payload.view.private_metadata);
            } catch {
              // 旧形式の場合は無視
            }
          }
          metadata.projects = projectIds;

          await fetch('https://slack.com/api/views.update', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${botToken}`
            },
            body: JSON.stringify({
              view_id: payload.view.id,
              view: {
                type: 'modal',
                callback_id: payload.view.callback_id,
                private_metadata: JSON.stringify(metadata),
                title: payload.view.title,
                submit: payload.view.submit,
                close: payload.view.close,
                blocks: payload.view.blocks
              }
            })
          });
        }
      }
      return res.status(200).send('');
    }

    // Modal送信時 → タスク作成
    if (payload.type === 'view_submission' && payload.view?.callback_id === 'task_create_modal') {
      const values = payload.view.state.values;

      // private_metadataからAI要約結果を取得（フォールバック用）
      let metadata = {};
      if (payload.view.private_metadata) {
        try {
          metadata = JSON.parse(payload.view.private_metadata);
        } catch {
          // 旧形式の場合
          if (payload.view.private_metadata.startsWith('projects:')) {
            metadata = { projects: payload.view.private_metadata.substring(9) };
          }
        }
      }

      const mentionUserIds = values.task_mentions?.mentions_select?.selected_users || [];
      // フォーム値がなければAI要約値を使用
      const content = values.task_content?.content_input?.value || metadata.ai_title || '';
      const description = values.task_description?.description_input?.value || metadata.ai_description || null;
      const dueString = values.task_due?.due_input?.value || metadata.ai_due || null;
      // 複数選択対応
      const selectedProjects = values.task_project?.project_select?.selected_options || [];
      const selectedSections = values.task_section?.section_select?.selected_options || [];

      if (!content) {
        return res.status(200).json({
          response_action: 'errors',
          errors: { task_content: 'タスク内容を入力してください' }
        });
      }

      if (selectedProjects.length === 0) {
        return res.status(200).json({
          response_action: 'errors',
          errors: { task_project: 'プロジェクトを選択してください' }
        });
      }

      // タスク作成（同期処理 - Vercel対応）
      try {
        const projects = await getTodoistProjects();
        const createdTasks = [];

        // 選択されたセクションを取得（noneを除外）
        const validSections = selectedSections.filter(s => s.value !== 'none');

        // 各プロジェクトにタスクを作成
        for (const projOption of selectedProjects) {
          const projectId = projOption.value;
          const proj = projects.find(p => p.id === projectId);
          const projectName = proj?.name || '';

          // このプロジェクトのセクション一覧を取得
          const projectSections = await getSections(projectId);

          // 選択されたセクションのうち、このプロジェクトに属するものをフィルタ
          const sectionsForProject = validSections.filter(selSec =>
            projectSections.some(ps => ps.id === selSec.value)
          );

          if (sectionsForProject.length > 0) {
            // このプロジェクトに属するセクションごとにタスクを作成
            for (const secOption of sectionsForProject) {
              const sectionId = secOption.value;
              const sec = projectSections.find(s => s.id === sectionId);
              const sectionName = sec?.name || '';

              const taskOptions = {
                ...(dueString && { due_string: dueString, due_lang: 'ja' }),
                project_id: projectId,
                section_id: sectionId,
                ...(description && { description: description })
              };

              const task = await createTodoistTask(content, taskOptions);
              createdTasks.push({ task, projectName, sectionName });
            }
          } else {
            // セクションなしでタスクを作成
            const taskOptions = {
              ...(dueString && { due_string: dueString, due_lang: 'ja' }),
              project_id: projectId,
              ...(description && { description: description })
            };

            const task = await createTodoistTask(content, taskOptions);
            createdTasks.push({ task, projectName, sectionName: '' });
          }
        }


        // 結果を通知（指定チャンネルまたはDM）
        const notifyChannel = process.env.SLACK_NOTIFICATION_CHANNEL || payload.user?.id;
        if (botToken && notifyChannel) {
          const mentions = mentionUserIds.map(id => `<@${id}>`).join(' ');

          let msg = `📍 <@${payload.user.id}> がTodoistにタスクを追加しました\n`;
          if (mentions) msg += `To: ${mentions}\n`;
          msg += `Task: *${content}*\n`;
          if (dueString) msg += `期日: ${dueString}\n`;
          if (description) msg += `説明: ${description}\n\n`;

          // 各タスクの情報とURLを表示
          for (const { task, projectName, sectionName } of createdTasks) {
            let hierarchy = projectName;
            if (sectionName) {
              hierarchy += ` > ${sectionName}`;
            }
            const taskUrl = task.url || `https://app.todoist.com/app/task/${task.id}`;
            msg += `🗂️ ${hierarchy} - <${taskUrl}|開く>\n`;
          }

          await postMessage(notifyChannel, msg, botToken);
        }
      } catch (err) {
        console.error(`[ERROR] Task creation failed: ${err.message}`);
        if (botToken && payload.user?.id) {
          await postMessage(payload.user.id, `❌ タスク作成に失敗しました: ${err.message}`, botToken);
        }
      }

      // Modalを閉じる
      return res.status(200).json({ response_action: 'clear' });
    }

    res.status(200).send('');
  } catch (error) {
    console.error(`[ERROR] /slack/interactivity: ${error.message}`);
    res.status(200).send('');
  }
});

// /api/slack/events - Slackイベント（app_mention）を処理
app.post('/api/slack/events', async (req, res) => {
  console.log('[DEBUG] /api/slack/events リクエスト受信');
  console.log('[DEBUG] body:', JSON.stringify(req.body, null, 2));

  try {
    const body = req.body;

    // URL検証（Slack App設定時に必要）
    if (body.type === 'url_verification') {
      console.log('[DEBUG] URL検証リクエスト');
      return res.status(200).json({ challenge: body.challenge });
    }

    // イベント処理
    if (body.type === 'event_callback') {
      const event = body.event;

      // app_mention イベント（@todoist_ai でメンションされた時）
      if (event.type === 'app_mention') {
        console.log('[DEBUG] app_mention イベント受信:', JSON.stringify(event, null, 2));

        // 即座に200を返す（3秒ルール対応）
        res.status(200).send('');

        // 以降は非同期で処理
        const botToken = process.env.SLACK_BOT_TOKEN;
        const channel = event.channel;
        const threadTs = event.thread_ts || event.ts;
        const userTs = event.ts;
        const mentionText = event.text || '';

        console.log('[DEBUG] channel:', channel, 'threadTs:', threadTs, 'userTs:', userTs);
        console.log('[DEBUG] mentionText:', mentionText);

        try {
          // メンションテキストからプロジェクト指定を抽出（#プロジェクト名）
          const projectMatch = mentionText.match(/#([^\s#]+)/);
          const specifiedProjectName = projectMatch ? projectMatch[1] : null;
          console.log('[DEBUG] specifiedProjectName:', specifiedProjectName);

          // スレッドのメッセージを取得
          const messages = await getThreadMessages(channel, threadTs, botToken);
          console.log('[DEBUG] messages count:', messages.length);

          if (messages.length === 0) {
            await postMessage(channel, '❌ スレッドの内容を取得できませんでした', botToken, userTs);
            return;
          }

          // スレッド内容をテキストに整形（ボットのメッセージを除外）
          const botUserId = body.authorizations?.[0]?.user_id;
          console.log('[DEBUG] botUserId:', botUserId);
          const threadContent = formatThreadContent(messages, botUserId);
          console.log('[DEBUG] threadContent:', threadContent);

          if (!threadContent) {
            await postMessage(channel, '❌ スレッドにタスク化できる内容がありませんでした', botToken, userTs);
            return;
          }

          // AIでタスク情報を解析
          console.log('[DEBUG] AI解析開始...');
          const taskInfo = await parseTaskWithAI(threadContent);
          console.log('[DEBUG] AI解析結果:', JSON.stringify(taskInfo, null, 2));

          if (!taskInfo.title) {
            await postMessage(channel, '❌ タスク情報を解析できませんでした', botToken, userTs);
            return;
          }

          // プロジェクトIDを解決
          let projectId = null;
          let projectName = null;
          if (specifiedProjectName) {
            console.log('[DEBUG] プロジェクト解決中:', specifiedProjectName);
            projectId = await resolveProjectId(specifiedProjectName);
            console.log('[DEBUG] 解決されたprojectId:', projectId);
            if (projectId) {
              const projects = await getTodoistProjects();
              const proj = projects.find(p => p.id === projectId);
              projectName = proj?.name || specifiedProjectName;
            }
          }

          // Todoistにタスクを作成
          const taskOptions = {
            ...(taskInfo.description && { description: taskInfo.description }),
            ...(taskInfo.due_date && { due_date: taskInfo.due_date }),
            ...(projectId && { project_id: projectId })
          };
          console.log('[DEBUG] タスク作成オプション:', JSON.stringify(taskOptions, null, 2));

          const task = await createTodoistTask(taskInfo.title, taskOptions);
          console.log('[DEBUG] 作成されたタスク:', JSON.stringify(task, null, 2));
          const taskUrl = task.url || `https://app.todoist.com/app/task/${task.id}`;
          console.log('[DEBUG] タスクURL:', taskUrl);

          // 結果をスレッドに返信
          let msg = `✅ Todoistにタスクを作成しました\n`;
          msg += `📝 *${taskInfo.title}*\n`;
          if (projectName) msg += `🗂️ ${projectName}\n`;
          if (taskInfo.priority) msg += `優先度: ${taskInfo.priority}\n`;
          if (taskInfo.due_date) msg += `期日: ${taskInfo.due_date}\n`;
          msg += `\n<${taskUrl}|Todoistで開く>`;

          // プロジェクト指定があったのにマッチしなかった場合は警告
          if (specifiedProjectName && !projectId) {
            msg += `\n\n⚠️ プロジェクト「${specifiedProjectName}」が見つからなかったため、Inboxに作成しました`;
          }

          await postMessage(channel, msg, botToken, userTs);

        } catch (err) {
          console.error(`[ERROR] app_mention処理エラー: ${err.message}`);
          await postMessage(channel, `❌ タスク作成に失敗しました: ${err.message}`, botToken, userTs);
        }

        return;
      }
    }

    // その他のイベントは無視
    res.status(200).send('');
  } catch (error) {
    console.error(`[ERROR] /api/slack/events: ${error.message}`);
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
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ? '✅ Set' : '❌ Not set',
    }
  };

  res.json(status);
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  if (!process.env.TODOIST_TOKEN) console.warn('警告: TODOIST_TOKEN が未設定です');
  if (!process.env.SLACK_SIGNING_SECRET) console.warn('警告: SLACK_SIGNING_SECRET が未設定です（本番では設定を推奨）');
});
