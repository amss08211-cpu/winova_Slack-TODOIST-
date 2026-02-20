/**
 * Slack API 関連の関数
 */

const { getTodoistProjects, getSections } = require('./todoist');

/**
 * Slack Modal を開く
 */
async function openTaskModal(triggerId, botToken) {
  // プロジェクト一覧を取得
  const projects = await getTodoistProjects();

  const projectOptions = projects.map(p => ({
    text: { type: 'plain_text', text: p.name },
    value: p.id
  }));

  // デフォルトプロジェクトを先頭に
  const defaultProject = projects.find(p => p.name.includes('winova_slack'));
  if (defaultProject) {
    const idx = projectOptions.findIndex(o => o.value === defaultProject.id);
    if (idx > 0) {
      const [item] = projectOptions.splice(idx, 1);
      projectOptions.unshift(item);
    }
  }

  const view = {
    type: 'modal',
    callback_id: 'task_create_modal',
    title: { type: 'plain_text', text: 'タスク作成' },
    submit: { type: 'plain_text', text: '作成' },
    close: { type: 'plain_text', text: 'キャンセル' },
    blocks: [
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
        block_id: 'task_due',
        label: { type: 'plain_text', text: '期日' },
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'due_input',
          placeholder: { type: 'plain_text', text: '例: 明日、来週月曜、2/20' }
        }
      },
      {
        type: 'input',
        block_id: 'task_project',
        label: { type: 'plain_text', text: 'プロジェクト' },
        element: {
          type: 'static_select',
          action_id: 'project_select',
          placeholder: { type: 'plain_text', text: 'プロジェクトを選択' },
          options: projectOptions.slice(0, 100) // Slackの制限
        }
      },
      {
        type: 'input',
        block_id: 'task_section',
        label: { type: 'plain_text', text: 'セクション' },
        optional: true,
        element: {
          type: 'static_select',
          action_id: 'section_select',
          placeholder: { type: 'plain_text', text: '先にプロジェクトを選択' },
          options: [
            { text: { type: 'plain_text', text: '（なし）' }, value: 'none' }
          ]
        }
      },
      {
        type: 'input',
        block_id: 'task_assignee',
        label: { type: 'plain_text', text: '担当者' },
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'assignee_input',
          placeholder: { type: 'plain_text', text: '例: 中村' }
        }
      }
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

module.exports = {
  openTaskModal,
  updateModalSections,
  postMessage
};
