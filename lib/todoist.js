/**
 * Todoist API 関連の関数
 */

// キャッシュ
let projectsCache = null;
let projectsCacheAt = 0;
let projectsPromise = null;
const PROJECTS_CACHE_TTL = 5 * 60 * 1000; // 5分

let sectionsCache = {};
const SECTIONS_CACHE_TTL = 5 * 60 * 1000; // 5分

let collaboratorsCache = null;
let collaboratorsCacheAt = 0;
const COLLABORATORS_CACHE_TTL = 10 * 60 * 1000; // 10分

/**
 * プロジェクト一覧を取得
 */
async function getTodoistProjects() {
  // キャッシュが有効ならそれを返す
  if (projectsCache && Date.now() - projectsCacheAt < PROJECTS_CACHE_TTL) {
    return projectsCache;
  }

  // 既に取得中のリクエストがあればそれに乗る
  if (projectsPromise) {
    return projectsPromise;
  }

  const token = process.env.TODOIST_TOKEN;
  if (!token) {
    console.error(`[ERROR ${new Date().toISOString()}] getTodoistProjects: No TODOIST_TOKEN`);
    return [];
  }

  projectsPromise = (async () => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch('https://api.todoist.com/api/v1/projects', {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        console.error(`[ERROR ${new Date().toISOString()}] getTodoistProjects: API returned ${res.status}`);
        return [];
      }
      const data = await res.json();
      const projects = Array.isArray(data) ? data : (data.results || data.projects || []);
      projectsCache = projects;
      projectsCacheAt = Date.now();
      return projects;
    } catch (error) {
      console.error(`[ERROR ${new Date().toISOString()}] getTodoistProjects: ${error.message}`);
      return [];
    } finally {
      projectsPromise = null;
    }
  })();

  return projectsPromise;
}

/**
 * セクション一覧を取得（プロジェクトIDを指定）
 */
async function getSections(projectId) {
  if (!projectId) {
    return [];
  }

  // キャッシュチェック
  const cached = sectionsCache[projectId];
  if (cached && Date.now() - cached.timestamp < SECTIONS_CACHE_TTL) {
    return cached.data;
  }

  const token = process.env.TODOIST_TOKEN;
  if (!token) {
    console.error(`[ERROR ${new Date().toISOString()}] getSections: No TODOIST_TOKEN`);
    return [];
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(`https://api.todoist.com/api/v1/sections?project_id=${projectId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.error(`[ERROR ${new Date().toISOString()}] getSections: API returned ${res.status}`);
      return [];
    }

    const data = await res.json();
    const sections = Array.isArray(data) ? data : (data.results || data.sections || []);

    // キャッシュに保存
    sectionsCache[projectId] = {
      data: sections,
      timestamp: Date.now()
    };

    return sections;
  } catch (error) {
    console.error(`[ERROR ${new Date().toISOString()}] getSections: ${error.message}`);
    return [];
  }
}

/**
 * プロジェクト名からプロジェクトIDを解決
 */
async function resolveProjectId(projectName) {
  if (!projectName || !projectName.trim()) {
    return null;
  }
  const name = projectName.trim();

  try {
    const projects = await getTodoistProjects();
    const match = projects.find((p) => p.name === name || p.name.includes(name) || name.includes(p.name));
    return match ? match.id : null;
  } catch (error) {
    console.error(`[ERROR ${new Date().toISOString()}] resolveProjectId: ${error.message}`);
    return null;
  }
}

/**
 * セクション名からセクションIDを解決
 */
async function resolveSectionId(projectId, sectionName) {
  if (!projectId || !sectionName) {
    return null;
  }

  const sections = await getSections(projectId);
  const normalizedName = sectionName.trim().toLowerCase();

  // 完全一致 → 部分一致 の順で検索
  const exactMatch = sections.find(s => s.name.toLowerCase() === normalizedName);
  if (exactMatch) return exactMatch.id;

  const partialMatch = sections.find(s =>
    s.name.toLowerCase().includes(normalizedName) ||
    normalizedName.includes(s.name.toLowerCase())
  );
  return partialMatch ? partialMatch.id : null;
}

/**
 * Todoistにタスクを作成
 */
async function createTodoistTask(content, options = {}) {
  const token = process.env.TODOIST_TOKEN;
  if (!token) {
    throw new Error('TODOIST_TOKEN が設定されていません');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  const res = await fetch('https://api.todoist.com/api/v1/tasks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ content, ...options }),
    signal: controller.signal
  });
  clearTimeout(timeoutId);

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`[ERROR ${new Date().toISOString()}] createTodoistTask: ${res.status} - ${errorText}`);
    throw new Error(`Todoist API エラー: ${res.status} ${errorText}`);
  }

  const task = await res.json();
  return task;
}

/**
 * Todoistタスクを更新
 */
async function updateTodoistTask(taskId, updates = {}) {
  const token = process.env.TODOIST_TOKEN;
  if (!token) {
    throw new Error('TODOIST_TOKEN が設定されていません');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  const res = await fetch(`https://api.todoist.com/api/v1/tasks/${taskId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(updates),
    signal: controller.signal
  });
  clearTimeout(timeoutId);

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`[ERROR ${new Date().toISOString()}] updateTodoistTask: ${res.status} - ${errorText}`);
    throw new Error(`Todoist API エラー: ${res.status} ${errorText}`);
  }

  const task = await res.json();
  return task;
}

/**
 * フィルタを使ってタスクを取得
 * @param {string} filter - Todoistフィルタ文字列（例: "due:today", "overdue"）
 * @returns {Promise<Array>} タスク配列
 */
async function getTasksByFilter(filter) {
  const token = process.env.TODOIST_TOKEN;
  if (!token) {
    console.error(`[ERROR ${new Date().toISOString()}] getTasksByFilter: No TODOIST_TOKEN`);
    return [];
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const url = `https://api.todoist.com/api/v1/tasks?filter=${encodeURIComponent(filter)}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.error(`[ERROR ${new Date().toISOString()}] getTasksByFilter: API returned ${res.status}`);
      return [];
    }

    const data = await res.json();
    return Array.isArray(data) ? data : (data.results || data.tasks || []);
  } catch (error) {
    console.error(`[ERROR ${new Date().toISOString()}] getTasksByFilter: ${error.message}`);
    return [];
  }
}

/**
 * Todoistコラボレーター（メンバー）一覧を取得
 * @returns {Promise<Array>} コラボレーター配列 { id, email, full_name, ... }
 */
async function getCollaborators() {
  // キャッシュが有効ならそれを返す
  if (collaboratorsCache && Date.now() - collaboratorsCacheAt < COLLABORATORS_CACHE_TTL) {
    return collaboratorsCache;
  }

  const token = process.env.TODOIST_TOKEN;
  if (!token) {
    console.error(`[ERROR ${new Date().toISOString()}] getCollaborators: No TODOIST_TOKEN`);
    return [];
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    // Sync API を使用してコラボレーターを取得
    const res = await fetch('https://api.todoist.com/sync/v9/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        sync_token: '*',
        resource_types: ['collaborators']
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.error(`[ERROR ${new Date().toISOString()}] getCollaborators: API returned ${res.status}`);
      return [];
    }

    const data = await res.json();
    const collaborators = data.collaborators || [];

    collaboratorsCache = collaborators;
    collaboratorsCacheAt = Date.now();

    return collaborators;
  } catch (error) {
    console.error(`[ERROR ${new Date().toISOString()}] getCollaborators: ${error.message}`);
    return [];
  }
}

/**
 * Todoist User ID からメールアドレスを取得
 * @param {string} todoistUserId - Todoist のユーザーID
 * @returns {Promise<string|null>} メールアドレス
 */
async function getTodoistUserEmail(todoistUserId) {
  if (!todoistUserId) return null;

  const collaborators = await getCollaborators();
  const user = collaborators.find(c => String(c.id) === String(todoistUserId));

  return user?.email || null;
}

/**
 * メールアドレスから Todoist User ID を取得
 * @param {string} email - メールアドレス
 * @returns {Promise<string|null>} Todoist User ID
 */
async function getTodoistIdByEmail(email) {
  if (!email) return null;

  const collaborators = await getCollaborators();
  const user = collaborators.find(c => c.email?.toLowerCase() === email.toLowerCase());

  return user?.id ? String(user.id) : null;
}

/**
 * 全プロジェクトからタスクを取得
 * @param {Object} options - オプション
 * @param {Array<string>} options.excludeProjects - 除外するプロジェクト名のパターン
 * @returns {Promise<Array>} タスク配列
 */
async function getAllTasks(options = {}) {
  const token = process.env.TODOIST_TOKEN;
  if (!token) {
    console.error(`[ERROR ${new Date().toISOString()}] getAllTasks: No TODOIST_TOKEN`);
    return [];
  }

  const excludeProjects = options.excludeProjects || ['はじめよう', 'インボックス', 'Inbox', 'てすと用', 'テスト用', 'Todoist', '谷田浦本タスク'];

  try {
    // プロジェクト一覧を取得
    const projects = await getTodoistProjects();

    // 除外プロジェクトをフィルタリング
    const targetProjects = projects.filter(p => {
      if (p.is_archived || p.is_deleted) return false;
      if (excludeProjects.some(ex => p.name.includes(ex))) return false;
      return true;
    });

    console.log(`[getAllTasks] Fetching tasks from ${targetProjects.length} projects`);

    // 各プロジェクトからタスクを取得（並列実行）
    const taskPromises = targetProjects.map(async (project) => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const res = await fetch(`https://api.todoist.com/api/v1/tasks?project_id=${project.id}`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          console.error(`[getAllTasks] Project ${project.id} returned ${res.status}`);
          return [];
        }

        const data = await res.json();
        const tasks = Array.isArray(data) ? data : (data.results || []);

        // プロジェクト名をタスクに付与
        return tasks.map(t => ({ ...t, _projectName: project.name }));
      } catch (err) {
        console.error(`[getAllTasks] Error fetching project ${project.id}: ${err.message}`);
        return [];
      }
    });

    const results = await Promise.all(taskPromises);
    const allTasks = results.flat();

    console.log(`[getAllTasks] Total tasks: ${allTasks.length}`);
    return allTasks;
  } catch (error) {
    console.error(`[ERROR ${new Date().toISOString()}] getAllTasks: ${error.message}`);
    return [];
  }
}

/**
 * 期日でタスクを取得（全プロジェクトから）
 * @param {string} type - 'today' | 'overdue' | 'upcoming' | 'all'
 * @param {Object} options - オプション
 * @param {number} options.upcomingDays - upcoming の場合、何日先まで取得するか（デフォルト: 3）
 * @returns {Promise<Array>} タスク配列
 */
async function getOverdueOrTodayTasks(type = 'all', options = {}) {
  const allTasks = await getAllTasks();
  const upcomingDays = options.upcomingDays || 3;

  // ローカルタイムゾーンで日付を取得（YYYY-MM-DD形式）
  const formatDate = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = formatDate(today);

  // N日後の日付を計算
  const futureDate = new Date(today);
  futureDate.setDate(futureDate.getDate() + upcomingDays);
  const futureDateStr = formatDate(futureDate);

  return allTasks.filter(task => {
    const dueDate = task.due?.date;
    const deadlineDate = task.deadline?.date;

    if (type === 'upcoming') {
      // upcoming は deadline フィールドのみ使用（UI上の「期日」）
      if (!deadlineDate) return false;
      // 明日〜N日後まで（今日と超過は含まない）
      return deadlineDate > todayStr && deadlineDate <= futureDateStr;
    }

    // today, overdue, all は due.date と deadline の両方をチェック
    // どちらかが該当すれば通知対象
    if (type === 'today') {
      return dueDate === todayStr || deadlineDate === todayStr;
    } else if (type === 'overdue') {
      return (dueDate && dueDate < todayStr) || (deadlineDate && deadlineDate < todayStr);
    } else {
      // 'all' - today or overdue
      return (dueDate && dueDate <= todayStr) || (deadlineDate && deadlineDate <= todayStr);
    }
  });
}

module.exports = {
  getTodoistProjects,
  getSections,
  resolveProjectId,
  resolveSectionId,
  createTodoistTask,
  updateTodoistTask,
  getTasksByFilter,
  getCollaborators,
  getTodoistUserEmail,
  getTodoistIdByEmail,
  getAllTasks,
  getOverdueOrTodayTasks
};
