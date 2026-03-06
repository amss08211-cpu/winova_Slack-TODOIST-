/**
 * リマインダー共通ロジック
 */

const { getTasksByFilter, getTodoistProjects, getTodoistUserEmail } = require('./todoist');
const { postMessage, findSlackUserByEmail } = require('./slack');
const { getBotToken, getNotificationChannel, WORKSPACES } = require('./workspaces');

/**
 * Todoist User ID から Slack User ID を取得（メールアドレスで自動マッチング）
 * @param {string} todoistUserId - Todoist のユーザーID
 * @param {string} botToken - Slack Bot Token
 * @returns {Promise<string|null>} Slack のユーザーID
 */
async function getSlackIdByTodoistId(todoistUserId, botToken) {
  if (!todoistUserId || !botToken) return null;

  // Todoist User ID → メールアドレス
  const email = await getTodoistUserEmail(todoistUserId);
  if (!email) {
    console.log(`[reminder] No email found for Todoist user ${todoistUserId}`);
    return null;
  }

  // メールアドレス → Slack User ID
  const slackId = await findSlackUserByEmail(email, botToken);
  if (!slackId) {
    console.log(`[reminder] No Slack user found for email ${email}`);
  }

  return slackId;
}

/**
 * 期日超過の日数を計算
 * @param {string} dueDate - YYYY-MM-DD 形式の期日
 * @returns {number} 超過日数（0以上）
 */
function getOverdueDays(dueDate) {
  if (!dueDate) return 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);

  const diffTime = today.getTime() - due.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

  return Math.max(0, diffDays);
}

/**
 * タスク1行分のテキストを生成
 */
function buildTaskLine(task, projectName, slackUserId, overdueDays = 0) {
  const taskUrl = task.url || `https://app.todoist.com/app/task/${task.id}`;
  const mention = slackUserId ? `<@${slackUserId}> ` : '';
  const overdueText = overdueDays > 0 ? ` (${overdueDays}日超過)` : '';

  return `${mention}📝 *${task.content}* - ${projectName}${overdueText} <${taskUrl}|開く>`;
}

/**
 * まとめてリマインダーメッセージを生成
 */
function buildConsolidatedMessage(type, taskLines) {
  const count = taskLines.length;

  if (type === 'today') {
    return `⏰ *今日が期日のタスク（${count}件）*\n\n${taskLines.join('\n')}`;
  } else {
    return `🚨 *期日を過ぎているタスク（${count}件）*\n\n${taskLines.join('\n')}`;
  }
}

// 除外するプロジェクト名
const EXCLUDE_PROJECT_NAMES = ['はじめよう', 'インボックス', 'てすと用３', 'テスト用３'];

/**
 * リマインダーを送信（両ワークスペースに通知）
 * @param {string} type - 'today' または 'overdue'
 * @returns {Promise<object>} 結果
 */
async function sendReminders(type) {
  const filter = type === 'today' ? 'due:today' : 'overdue';
  const results = { sent: 0, skipped: 0, errors: [] };

  try {
    // タスクとプロジェクトを取得
    const [allTasks, projects] = await Promise.all([
      getTasksByFilter(filter),
      getTodoistProjects()
    ]);

    console.log(`[reminder-${type}] Found ${allTasks.length} tasks (before filter)`);

    // プロジェクトIDからプロジェクト名へのマップを作成
    const projectMap = {};
    const excludeProjectIds = new Set();
    for (const p of projects) {
      projectMap[p.id] = p.name;
      // 除外プロジェクトのIDを収集
      if (EXCLUDE_PROJECT_NAMES.some(name => p.name.includes(name))) {
        excludeProjectIds.add(p.id);
      }
    }

    // フィルタリング: 期日あり & 除外プロジェクト以外
    const tasks = allTasks.filter(task => {
      // 期日がないタスクは除外
      if (!task.due?.date) {
        results.skipped++;
        return false;
      }
      // 除外プロジェクトのタスクは除外
      if (excludeProjectIds.has(task.project_id)) {
        results.skipped++;
        return false;
      }
      return true;
    });

    console.log(`[reminder-${type}] After filter: ${tasks.length} tasks (skipped: ${results.skipped})`);

    if (tasks.length === 0) {
      return results;
    }

    // 各ワークスペースに通知（1メッセージにまとめる）
    for (const workspaceId of Object.keys(WORKSPACES)) {
      const botToken = getBotToken(workspaceId);
      const channel = getNotificationChannel(workspaceId);

      if (!botToken || !channel) {
        console.log(`[reminder-${type}] Skip ${workspaceId}: no token or channel`);
        continue;
      }

      try {
        // 全タスクの行を生成
        const taskLines = [];
        for (const task of tasks) {
          const projectName = projectMap[task.project_id] || '不明なプロジェクト';
          const slackUserId = await getSlackIdByTodoistId(task.responsible_uid, botToken);
          const overdueDays = type === 'overdue' ? getOverdueDays(task.due?.date) : 0;

          const line = buildTaskLine(task, projectName, slackUserId, overdueDays);
          taskLines.push(line);
        }

        // まとめて1メッセージ送信
        const message = buildConsolidatedMessage(type, taskLines);
        await postMessage(channel, message, botToken);
        results.sent += tasks.length;

      } catch (err) {
        console.error(`[reminder-${type}] Error sending to ${workspaceId}:`, err.message);
        results.errors.push({ workspaceId, error: err.message });
      }
    }

  } catch (err) {
    console.error(`[reminder-${type}] Error:`, err.message);
    results.errors.push({ error: err.message });
  }

  return results;
}

module.exports = {
  getSlackIdByTodoistId,
  getOverdueDays,
  buildTaskLine,
  buildConsolidatedMessage,
  sendReminders
};
