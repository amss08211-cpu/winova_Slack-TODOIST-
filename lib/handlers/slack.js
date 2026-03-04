/**
 * Slack共通ハンドラー
 * foresma/winova両方で使用
 */

const { openTaskModal, postMessage } = require('../slack');
const { getTodoistProjects, getSections, createTodoistTask } = require('../todoist');
const { parseTaskWithAI } = require('../ai');
const { getBotToken, getSigningSecret, getNotificationChannel } = require('../workspaces');
const crypto = require('crypto');

/**
 * 署名検証
 */
function verifySlackRequest(rawBody, signature, timestamp, signingSecret) {
  if (!signingSecret) return true;
  if (!signature || !signature.startsWith('v0=')) return false;
  if (!timestamp) return false;

  const currentTime = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTime - timestamp) > 60 * 5) {
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const mySig = 'v0=' + crypto
    .createHmac('sha256', signingSecret)
    .update(sigBasestring)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(mySig));
}

/**
 * コマンドハンドラー
 */
async function handleCommand(req, res, workspaceId) {
  const rawBody = req.rawBody;
  const signature = req.headers['x-slack-signature'];
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signingSecret = getSigningSecret(workspaceId);

  if (signingSecret && !verifySlackRequest(rawBody, signature, timestamp, signingSecret)) {
    console.error(`[${workspaceId}] Signature verification failed`);
    return res.status(401).send('Invalid signature');
  }

  const params = new URLSearchParams(rawBody);
  const triggerId = params.get('trigger_id');
  const botToken = getBotToken(workspaceId);

  if (!botToken) {
    return res.status(200).json({
      response_type: 'ephemeral',
      text: `❌ SLACK_BOT_TOKEN_${workspaceId.toUpperCase()} が設定されていません。`,
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
    return res.status(200).send('');
  } catch (err) {
    console.error(`[${workspaceId}] Failed to open modal: ${err.message}`);
    return res.status(200).json({
      response_type: 'ephemeral',
      text: `❌ Modalを開けませんでした: ${err.message}`,
    });
  }
}

/**
 * Interactivityハンドラー
 */
async function handleInteractivity(req, res, workspaceId) {
  try {
    if (!req.body?.payload) {
      console.error(`[${workspaceId}] No payload in request body`);
      return res.status(200).send('');
    }
    const payload = JSON.parse(req.body.payload);
    const botToken = getBotToken(workspaceId);

    // block_suggestion
    if (payload.type === 'block_suggestion') {
      return handleBlockSuggestion(payload, res, workspaceId);
    }

    // block_actions
    if (payload.type === 'block_actions') {
      return handleBlockActions(payload, res, workspaceId, botToken);
    }

    // view_submission
    if (payload.type === 'view_submission' && payload.view?.callback_id === 'task_create_modal') {
      return handleViewSubmission(payload, res, workspaceId, botToken);
    }

    res.status(200).send('');
  } catch (error) {
    console.error(`[${workspaceId}] /slack/interactivity: ${error.message}`);
    res.status(200).send('');
  }
}

/**
 * block_suggestion ハンドラー
 */
async function handleBlockSuggestion(payload, res, workspaceId) {
  const actionId = payload.action_id;
  const query = (payload.value || '').trim();
  const queryLower = query.toLowerCase();

  // プロジェクト候補
  if (actionId === 'project_select') {
    const projects = await getTodoistProjects();

    const excludeNames = ['はじめよう', 'インボックス', 'てすと用３', 'テスト用３'];
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

  // セクション候補
  if (actionId === 'section_select') {
    let projectIds = [];

    // private_metadataから取得（block_suggestionではstate.valuesが空のため）
    if (payload.view?.private_metadata) {
      // フォールバック: private_metadataから取得
      try {
        const meta = JSON.parse(payload.view.private_metadata);
        projectIds = meta.projects ? meta.projects.split(',') : [];
      } catch {
        const metadata = payload.view.private_metadata;
        projectIds = metadata.startsWith('projects:') ? metadata.substring(9).split(',') : [];
      }
    }

    let options = [
      { text: { type: 'plain_text', text: '（なし）' }, value: 'none' }
    ];

    if (projectIds.length > 0) {
      const projects = await getTodoistProjects();

      for (const projectId of projectIds) {
        const proj = projects.find(p => p.id === projectId);
        if (!proj) continue;

        const sections = await getSections(projectId);
        const sortedSections = [...sections].sort((a, b) =>
          (a.section_order || a.order || 0) - (b.section_order || b.order || 0)
        );
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

/**
 * block_actions ハンドラー
 */
async function handleBlockActions(payload, res, workspaceId, botToken) {
  const action = payload.actions?.[0];

  // AI要約ボタン
  if (action?.action_id === 'ai_summarize') {
    const values = payload.view.state.values;
    const sourceText = values.ai_source?.ai_source_input?.value || '';

    if (!sourceText.trim()) {
      return res.status(200).send('');
    }

    try {
      const taskInfo = await parseTaskWithAI(sourceText);

      const updatedBlocks = payload.view.blocks.map(block => {
        if (block.block_id === 'task_content') {
          return { ...block, element: { ...block.element, initial_value: taskInfo.title || '' } };
        }
        if (block.block_id === 'task_description') {
          return { ...block, element: { ...block.element, initial_value: taskInfo.description || '' } };
        }
        if (block.block_id === 'task_due') {
          return { ...block, element: { ...block.element, initial_value: taskInfo.due_date || '' } };
        }
        return block;
      });

      let metadata = parseMetadata(payload.view.private_metadata);
      metadata.ai_title = taskInfo.title || '';
      metadata.ai_description = taskInfo.description || '';
      metadata.ai_due = taskInfo.due_date || '';
      metadata.ai_source = sourceText;

      await updateModal(botToken, payload.view.id, payload.view, updatedBlocks, metadata);
    } catch (err) {
      console.error(`[${workspaceId}] AI要約エラー: ${err.message}`);
    }

    return res.status(200).send('');
  }

  // プロジェクト選択 → metadataに保存（block_suggestionではstate.valuesが空のため）
  if (action?.action_id === 'project_select') {
    const selectedOptions = action.selected_options || [];
    const projectIds = selectedOptions.map(opt => opt.value).join(',');

    if (botToken) {
      let metadata = parseMetadata(payload.view.private_metadata);
      metadata.projects = projectIds;

      await updateModal(botToken, payload.view.id, payload.view, payload.view.blocks, metadata);
    }
  }

  return res.status(200).send('');
}

/**
 * view_submission ハンドラー
 */
async function handleViewSubmission(payload, res, workspaceId, botToken) {
  const values = payload.view.state.values;
  const metadata = parseMetadata(payload.view.private_metadata);

  const mentionUserIds = values.task_mentions?.mentions_select?.selected_users || [];
  const content = values.task_content?.content_input?.value || metadata.ai_title || '';
  const description = values.task_description?.description_input?.value || metadata.ai_description || null;
  const dueString = values.task_due?.due_input?.value || metadata.ai_due || null;
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

  try {
    const projects = await getTodoistProjects();
    const createdTasks = [];
    const validSections = selectedSections.filter(s => s.value !== 'none');

    for (const projOption of selectedProjects) {
      const projectId = projOption.value;
      const proj = projects.find(p => p.id === projectId);
      const projectName = proj?.name || '';
      const projectSections = await getSections(projectId);

      const sectionsForProject = validSections.filter(selSec =>
        projectSections.some(ps => ps.id === selSec.value)
      );

      if (sectionsForProject.length > 0) {
        for (const secOption of sectionsForProject) {
          const sectionId = secOption.value;
          const sec = projectSections.find(s => s.id === sectionId);
          const sectionName = sec?.name || '';

          const taskOptions = {
            ...(dueString && { due_string: dueString, due_lang: 'ja' }),
            project_id: projectId,
            section_id: sectionId,
            ...(description && { description })
          };

          const task = await createTodoistTask(content, taskOptions);
          createdTasks.push({ task, projectName, sectionName });
        }
      } else {
        const taskOptions = {
          ...(dueString && { due_string: dueString, due_lang: 'ja' }),
          project_id: projectId,
          ...(description && { description })
        };

        const task = await createTodoistTask(content, taskOptions);
        createdTasks.push({ task, projectName, sectionName: '' });
      }
    }

    // 通知
    const notifyChannel = getNotificationChannel(workspaceId) || payload.user?.id;
    if (botToken && notifyChannel) {
      const mentions = mentionUserIds.map(id => `<@${id}>`).join(' ');

      let msg = `📍 <@${payload.user.id}> がTodoistにタスクを追加しました\n`;
      if (mentions) msg += `To: ${mentions}\n`;
      msg += `Task: *${content}*\n`;
      if (dueString) msg += `期日: ${dueString}\n`;
      if (description) msg += `説明: ${description}\n\n`;

      for (const { task, projectName, sectionName } of createdTasks) {
        let hierarchy = projectName;
        if (sectionName) hierarchy += ` > ${sectionName}`;
        const taskUrl = task.url || `https://app.todoist.com/app/task/${task.id}`;
        msg += `🗂️ ${hierarchy} - <${taskUrl}|開く>\n`;
      }

      await postMessage(notifyChannel, msg, botToken);
    }
  } catch (err) {
    console.error(`[${workspaceId}] Task creation failed: ${err.message}`);
    if (botToken && payload.user?.id) {
      await postMessage(payload.user.id, `❌ タスク作成に失敗しました: ${err.message}`, botToken);
    }
  }

  return res.status(200).json({ response_action: 'clear' });
}

/**
 * ユーティリティ: メタデータのパース
 */
function parseMetadata(privateMetadata) {
  if (!privateMetadata) return {};
  try {
    return JSON.parse(privateMetadata);
  } catch {
    if (privateMetadata.startsWith('projects:')) {
      return { projects: privateMetadata.substring(9) };
    }
    return {};
  }
}

/**
 * ユーティリティ: モーダル更新（リトライ付き）
 */
async function updateModal(botToken, viewId, currentView, blocks, metadata, retries = 1) {
  try {
    const response = await fetch('https://slack.com/api/views.update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${botToken}`
      },
      body: JSON.stringify({
        view_id: viewId,
        view: {
          type: 'modal',
          callback_id: currentView.callback_id,
          private_metadata: JSON.stringify(metadata),
          title: currentView.title,
          submit: currentView.submit,
          close: currentView.close,
          blocks
        }
      })
    });
    const result = await response.json();
    if (!result.ok) {
      if (result.error === 'not_found' && retries > 0) {
        // リトライ
        await new Promise(r => setTimeout(r, 100));
        return updateModal(botToken, viewId, currentView, blocks, metadata, retries - 1);
      }
      console.error('[updateModal] Error:', result.error);
    }
  } catch (err) {
    console.error('[updateModal] Exception:', err.message);
  }
}

/**
 * Raw body パーサー
 */
function rawBodyParser(req, res, next) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks).toString('utf8');
    next();
  });
}

module.exports = {
  handleCommand,
  handleInteractivity,
  rawBodyParser
};
