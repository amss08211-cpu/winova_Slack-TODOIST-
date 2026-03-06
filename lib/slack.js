/**
 * Slack API 関連の関数
 */

const { getTodoistProjects, getSections } = require('./todoist');

// Slackユーザーキャッシュ
let slackUsersCache = null;
let slackUsersCacheAt = 0;
const SLACK_USERS_CACHE_TTL = 10 * 60 * 1000; // 10分

/**
 * Slack Modal を開く
 */
async function openTaskModal(triggerId, botToken) {
  // プロジェクト一覧を取得
  const projects = await getTodoistProjects();

  // child_orderでソート（Todoistの表示順）
  const sortedProjects = [...projects].sort((a, b) => {
    // まずfolder_idでグループ化（nullは最後）
    if (a.folder_id !== b.folder_id) {
      if (!a.folder_id) return 1;
      if (!b.folder_id) return -1;
      return String(a.folder_id).localeCompare(String(b.folder_id));
    }
    // 同じフォルダ内ではchild_orderでソート
    return (a.child_order || 0) - (b.child_order || 0);
  });

  const projectOptions = sortedProjects.map(p => ({
    text: { type: 'plain_text', text: p.name },
    value: p.id
  }));

  const view = {
    type: 'modal',
    callback_id: 'task_create_modal',
    title: { type: 'plain_text', text: 'タスク作成' },
    submit: { type: 'plain_text', text: '作成' },
    close: { type: 'plain_text', text: 'キャンセル' },
    blocks: [
      {
        type: 'input',
        block_id: 'ai_source',
        label: { type: 'plain_text', text: '📝 AI要約元（話し言葉OK）' },
        optional: true,
        dispatch_action: true,
        element: {
          type: 'plain_text_input',
          action_id: 'ai_source_input',
          multiline: true,
          placeholder: { type: 'plain_text', text: '例: 来週月曜にクライアントとミーティングあるから、金曜までに資料作らないと。内容は売上報告と来期計画をまとめる感じで' }
        }
      },
      {
        type: 'actions',
        block_id: 'ai_actions',
        elements: [
          {
            type: 'button',
            action_id: 'ai_summarize',
            text: { type: 'plain_text', text: '✨ AI要約' },
            style: 'primary'
          }
        ]
      },
      {
        type: 'divider'
      },
      {
        type: 'input',
        block_id: 'task_mentions',
        label: { type: 'plain_text', text: '@メンション' },
        optional: true,
        element: {
          type: 'multi_users_select',
          action_id: 'mentions_select',
          placeholder: { type: 'plain_text', text: 'メンションする人を選択' }
        }
      },
      {
        type: 'input',
        block_id: 'task_project',
        label: { type: 'plain_text', text: 'プロジェクト' },
        dispatch_action: true,
        element: {
          type: 'multi_external_select',
          action_id: 'project_select',
          placeholder: { type: 'plain_text', text: 'プロジェクトを選択（複数可）' },
          min_query_length: 0
        }
      },
      {
        type: 'input',
        block_id: 'task_section',
        label: { type: 'plain_text', text: 'セクション' },
        optional: true,
        element: {
          type: 'multi_external_select',
          action_id: 'section_select',
          placeholder: { type: 'plain_text', text: 'セクションを選択（複数可）' },
          min_query_length: 0
        }
      },
      {
        type: 'input',
        block_id: 'task_content',
        label: { type: 'plain_text', text: 'タスク内容' },
        element: {
          type: 'plain_text_input',
          action_id: 'content_input',
          placeholder: { type: 'plain_text', text: '例: 資料作成' }
        }
      },
      {
        type: 'input',
        block_id: 'task_description',
        label: { type: 'plain_text', text: '説明' },
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'description_input',
          multiline: true,
          placeholder: { type: 'plain_text', text: '詳細な説明を入力' }
        }
      },
      {
        type: 'input',
        block_id: 'task_due',
        label: { type: 'plain_text', text: '期日' },
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'due_input',
          placeholder: { type: 'plain_text', text: '例: 明日、来週月曜、2/20' }
        }
      },
      // {
      //   type: 'input',
      //   block_id: 'task_assignee',
      //   label: { type: 'plain_text', text: '担当者' },
      //   optional: true,
      //   element: {
      //     type: 'users_select',
      //     action_id: 'assignee_select',
      //     placeholder: { type: 'plain_text', text: '担当者を選択' }
      //   }
      // }
    ]
  };

  const res = await fetch('https://slack.com/api/views.open', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${botToken}`
    },
    body: JSON.stringify({
      trigger_id: triggerId,
      view: view
    })
  });

  const data = await res.json();
  if (!data.ok) {
    console.error(`[ERROR] openTaskModal: ${data.error}`);
    throw new Error(`Slack API エラー: ${data.error}`);
  }

  return data;
}

/**
 * Modal のセクション選択肢を更新
 */
async function updateModalSections(viewId, projectId, botToken, currentView) {
  // セクション一覧を取得
  const sections = await getSections(projectId);

  const sectionOptions = [
    { text: { type: 'plain_text', text: '（なし）' }, value: 'none' }
  ];

  sections.forEach(s => {
    sectionOptions.push({
      text: { type: 'plain_text', text: s.name },
      value: s.id
    });
  });

  // 現在のviewからblocksを取得して、セクションのoptionsを更新
  const blocks = currentView.blocks.map(block => {
    if (block.block_id === 'task_section') {
      return {
        ...block,
        element: {
          ...block.element,
          options: sectionOptions
        }
      };
    }
    return block;
  });

  const res = await fetch('https://slack.com/api/views.update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${botToken}`
    },
    body: JSON.stringify({
      view_id: viewId,
      view: {
        type: 'modal',
        callback_id: 'task_create_modal',
        title: currentView.title,
        submit: currentView.submit,
        close: currentView.close,
        blocks: blocks
      }
    })
  });

  const data = await res.json();
  if (!data.ok) {
    console.error(`[ERROR] updateModalSections: ${data.error}`);
  }

  return data;
}

/**
 * Slack にメッセージを送信
 */
async function postMessage(channel, text, botToken, threadTs = null) {
  const body = {
    channel,
    text,
    ...(threadTs && { thread_ts: threadTs })
  };

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${botToken}`
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!data.ok) {
    console.error(`[ERROR] postMessage: ${data.error}`);
  }

  return data;
}

/**
 * Slackユーザー一覧を取得
 */
async function getSlackUsers(botToken) {
  if (slackUsersCache && Date.now() - slackUsersCacheAt < SLACK_USERS_CACHE_TTL) {
    return slackUsersCache;
  }

  try {
    const res = await fetch('https://slack.com/api/users.list', {
      headers: { 'Authorization': `Bearer ${botToken}` }
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`[ERROR] getSlackUsers: ${data.error}`);
      return [];
    }
    slackUsersCache = data.members || [];
    slackUsersCacheAt = Date.now();
    return slackUsersCache;
  } catch (error) {
    console.error(`[ERROR] getSlackUsers: ${error.message}`);
    return [];
  }
}

/**
 * 名前からSlackユーザーIDを検索
 */
async function findSlackUserByName(name, botToken) {
  if (!name || !botToken) return null;

  const users = await getSlackUsers(botToken);
  const searchName = name.trim().toLowerCase();

  // 完全一致 → 部分一致の順で検索
  const match = users.find(u => {
    if (u.deleted || u.is_bot) return false;
    const realName = (u.real_name || '').toLowerCase();
    const displayName = (u.profile?.display_name || '').toLowerCase();
    return realName === searchName || displayName === searchName;
  }) || users.find(u => {
    if (u.deleted || u.is_bot) return false;
    const realName = (u.real_name || '').toLowerCase();
    const displayName = (u.profile?.display_name || '').toLowerCase();
    return realName.includes(searchName) || displayName.includes(searchName);
  });

  return match ? match.id : null;
}

/**
 * スレッドのメッセージ一覧を取得
 */
async function getThreadMessages(channel, threadTs, botToken) {
  if (!channel || !threadTs || !botToken) {
    console.error('[ERROR] getThreadMessages: 必須パラメータが不足');
    return [];
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(
      `https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}&limit=50`,
      {
        headers: { 'Authorization': `Bearer ${botToken}` },
        signal: controller.signal
      }
    );
    clearTimeout(timeoutId);

    const data = await res.json();
    if (!data.ok) {
      console.error(`[ERROR] getThreadMessages: ${data.error}`);
      return [];
    }

    return data.messages || [];
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('[ERROR] getThreadMessages: タイムアウト');
    } else {
      console.error(`[ERROR] getThreadMessages: ${error.message}`);
    }
    return [];
  }
}

/**
 * スレッド内容をテキストに整形
 */
function formatThreadContent(messages, botUserId) {
  if (!messages || messages.length === 0) {
    return '';
  }

  // ボット自身のメッセージと、メンション部分を除外
  const filtered = messages
    .filter(m => m.user !== botUserId)
    .map(m => {
      // <@USERID> 形式のメンションを除去
      return m.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    })
    .filter(text => text.length > 0);

  return filtered.join('\n\n');
}

/**
 * Slack User ID からメールアドレスを取得
 * @param {string} slackUserId - Slack User ID
 * @param {string} botToken - Slack Bot Token
 * @returns {Promise<string|null>} メールアドレス
 */
async function getSlackUserEmail(slackUserId, botToken) {
  if (!slackUserId || !botToken) return null;

  try {
    const res = await fetch(`https://slack.com/api/users.info?user=${slackUserId}`, {
      headers: { 'Authorization': `Bearer ${botToken}` }
    });
    const data = await res.json();

    if (!data.ok) {
      console.error(`[ERROR] getSlackUserEmail: ${data.error}`);
      return null;
    }

    return data.user?.profile?.email || null;
  } catch (error) {
    console.error(`[ERROR] getSlackUserEmail: ${error.message}`);
    return null;
  }
}

/**
 * メールアドレスからSlackユーザーを検索
 * @param {string} email - メールアドレス
 * @param {string} botToken - Slack Bot Token
 * @returns {Promise<string|null>} Slack User ID
 */
async function findSlackUserByEmail(email, botToken) {
  if (!email || !botToken) return null;

  try {
    const res = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
      headers: { 'Authorization': `Bearer ${botToken}` }
    });
    const data = await res.json();

    if (!data.ok) {
      // users_not_found は正常（そのメールのユーザーがいないだけ）
      if (data.error !== 'users_not_found') {
        console.error(`[ERROR] findSlackUserByEmail: ${data.error}`);
      }
      return null;
    }

    return data.user?.id || null;
  } catch (error) {
    console.error(`[ERROR] findSlackUserByEmail: ${error.message}`);
    return null;
  }
}

module.exports = {
  openTaskModal,
  updateModalSections,
  postMessage,
  findSlackUserByName,
  findSlackUserByEmail,
  getSlackUserEmail,
  getThreadMessages,
  formatThreadContent
};
