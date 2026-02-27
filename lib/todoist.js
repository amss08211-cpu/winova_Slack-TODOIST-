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

module.exports = {
  getTodoistProjects,
  getSections,
  resolveProjectId,
  resolveSectionId,
  createTodoistTask,
  updateTodoistTask
};
