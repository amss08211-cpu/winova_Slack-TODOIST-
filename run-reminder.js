/**
 * 進行止まりタスク（期日過ぎ）をTodoistから取得し、
 * 担当者をSlackでメンションしてリマインドする
 *
 * 使い方: node run-reminder.js
 *  cron例: 0 9 * * * cd /path/to/Slack-Todoist連携 && node run-reminder.js
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');

const TODOIST_TOKEN = process.env.TODOIST_TOKEN;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_REMINDER_CHANNEL = process.env.SLACK_REMINDER_CHANNEL; // チャンネルID (C01234...)

let ownerToSlackId = {};
try {
  const configPath = path.join(__dirname, 'config', 'owners.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  ownerToSlackId = config.ownerToSlackId || {};
} catch (e) {
  console.warn('config/owners.json が読めません:', e.message);
}

function getOverdueTasks() {
  const url = new URL('https://api.todoist.com/rest/v2/tasks');
  url.searchParams.set('filter', 'overdue');
  return fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${TODOIST_TOKEN}` },
  }).then(async (res) => {
    if (!res.ok) throw new Error(`Todoist: ${res.status} ${await res.text()}`);
    return res.json();
  });
}

function getOwnerFromDescription(description) {
  if (!description) return null;
  const m = description.match(/担当\s*[：:]\s*(\S+)/);
  return m ? m[1].trim() : null;
}

async function postSlackMessage(text) {
  if (!SLACK_BOT_TOKEN || !SLACK_REMINDER_CHANNEL) {
    console.warn('SLACK_BOT_TOKEN または SLACK_REMINDER_CHANNEL が未設定です');
    return;
  }
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: SLACK_REMINDER_CHANNEL,
      text,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack: ${data.error || res.status}`);
}

async function main() {
  if (!TODOIST_TOKEN) {
    console.error('TODOIST_TOKEN が設定されていません');
    process.exit(1);
  }

  const tasks = await getOverdueTasks();
  if (tasks.length === 0) {
    console.log('期日過ぎタスクはありません');
    return;
  }

  for (const task of tasks) {
    const owner = getOwnerFromDescription(task.description);
    const slackId = owner && ownerToSlackId[owner];
    const dueDate = task.due?.date || task.due?.string || '（期日不明）';

    let text = `タスク「${task.content}」の期日が過ぎています（期日: ${dueDate}）`;
    if (slackId) {
      text = `<@${slackId}> ${text}`;
    } else if (owner) {
      text = `${owner} さん: ${text}`;
    }

    try {
      await postSlackMessage(text);
      console.log('送信:', task.content, owner || '担当なし');
    } catch (e) {
      console.error('送信失敗:', task.content, e.message);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
