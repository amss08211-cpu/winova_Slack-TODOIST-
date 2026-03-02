/**
 * AI解析関連の関数（OpenAI GPT-4o-mini使用）
 */

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const TIMEOUT_MS = 15000;

/**
 * スレッド内容からタスク情報をAIで解析
 * @param {string} threadContent - スレッドのメッセージ内容
 * @returns {Promise<{title: string, description: string, priority: string|null, due_date: string|null}>}
 */
async function parseTaskWithAI(threadContent) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.warn('[AI] OPENAI_API_KEY未設定。フォールバック処理を実行');
    return fallbackParse(threadContent);
  }

  const systemPrompt = `あなたはSlackのスレッド内容からタスク情報を抽出するアシスタントです。

以下のルールに従ってJSONのみを返してください：
- title: スレッド内容を要約した簡潔なタスク名（15〜40文字目安）
- description: タスクの詳細説明（スレッド内容の要約）
- priority: 優先度（"高"/"中"/"低" または null）
  - 「緊急」「至急」「ASAP」「今日中」→ "高"
  - 「来週」「余裕があれば」→ "低"
  - 明示されていない場合 → null
- due_date: 期日（自然言語で返す。例: "明日", "金曜", "来週月曜", "3/2" など）
  - 元のテキストに期日表現があればそのまま使う
  - 明示されていない場合 → null

今日の日付: ${getTodayWithWeekday()}`;

  const userPrompt = `以下のSlackスレッド内容からタスク情報を抽出してください：

${threadContent}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[AI] OpenAI API エラー: ${response.status} - ${errorText}`);
      return fallbackParse(threadContent);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      console.error('[AI] OpenAI レスポンスが空');
      return fallbackParse(threadContent);
    }

    const parsed = JSON.parse(content);

    // 結果を正規化
    return {
      title: normalizeTitle(parsed.title || ''),
      description: parsed.description || '',
      priority: normalizePriority(parsed.priority),
      due_date: parsed.due_date || null
    };

  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('[AI] OpenAI API タイムアウト');
    } else {
      console.error(`[AI] エラー: ${error.message}`);
    }
    return fallbackParse(threadContent);
  }
}

/**
 * AI未使用時のフォールバック処理
 */
function fallbackParse(content) {
  const lines = content.trim().split('\n').filter(l => l.trim());
  const firstLine = lines[0] || 'Slackからのタスク';

  return {
    title: normalizeTitle(firstLine),
    description: content.slice(0, 500),
    priority: null,
    due_date: null
  };
}

/**
 * タイトルを正規化（40文字以下、末尾の句読点除去）
 */
function normalizeTitle(title) {
  if (!title) return 'Slackからのタスク';

  let normalized = title
    .replace(/[。、！？!?]+$/, '')  // 末尾の句読点除去
    .trim();

  if (normalized.length > 40) {
    normalized = normalized.slice(0, 37) + '...';
  }

  return normalized || 'Slackからのタスク';
}

/**
 * 優先度を正規化
 */
function normalizePriority(priority) {
  if (!priority) return null;

  const p = priority.toLowerCase();
  if (p.includes('高') || p.includes('緊急') || p === 'high') return '高';
  if (p.includes('中') || p === 'medium') return '中';
  if (p.includes('低') || p === 'low') return '低';

  return null;
}

/**
 * 今日の日付をISO形式で取得（JST）
 */
function getTodayIsoDate() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().split('T')[0];
}

/**
 * 今日の日付と曜日を取得（JST）
 */
function getTodayWithWeekday() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const date = jst.toISOString().split('T')[0];
  const weekday = weekdays[jst.getDay()];
  return `${date}（${weekday}曜日）`;
}

module.exports = {
  parseTaskWithAI,
  getTodayIsoDate
};
