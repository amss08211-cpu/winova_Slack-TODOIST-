require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Todoist のプロジェクトメンバーを取得するスクリプト
async function getUserIds() {
    const token = process.env.TODOIST_TOKEN;
    if (!token) {
        console.error('TODOIST_TOKEN が設定されていません');
        return;
    }

    console.log('Todoist のプロジェクトメンバーを取得しています...\n');

    const projectId = '2366853196'; // winova_slack✖️todoist

    try {
        // まず、「ID取得テスト」というタスクを探す
        console.log('「ID取得テスト」タスクを検索中...');
        const tasksRes = await fetch(`https://api.todoist.com/rest/v2/tasks?project_id=${projectId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!tasksRes.ok) {
            throw new Error(`API エラー: ${tasksRes.status}`);
        }

        const tasks = await tasksRes.json();
        const testTask = tasks.find(t => t.content.includes('ID取得テスト'));

        if (!testTask) {
            console.log('⚠️  「ID取得テスト」タスクが見つかりませんでした。');
            console.log('\n次の手順を実行してください:');
            console.log('1. Todoist で「winova_slack✖️todoist」プロジェクトを開く');
            console.log('2. タスク名「ID取得テスト」を作成');
            console.log('3. コメント欄で全員をメンション（例: @浦本雅 @谷田倖輝 ...）');
            console.log('4. このスクリプトを再実行\n');
            return;
        }

        console.log(`✓ タスクが見つかりました: ${testTask.content} (ID: ${testTask.id})\n`);

        // タスクのコメントを取得
        console.log('コメントを取得中...');
        const commentsRes = await fetch(`https://api.todoist.com/rest/v2/comments?task_id=${testTask.id}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!commentsRes.ok) {
            throw new Error(`コメント取得エラー: ${commentsRes.status}`);
        }

        const comments = await commentsRes.json();
        console.log(`✓ ${comments.length} 件のコメントが見つかりました\n`);

        if (comments.length === 0) {
            console.log('⚠️  コメントがありません。タスクのコメント欄で全員をメンションしてください。\n');
            return;
        }

        // コメントからメンションされたユーザー情報を抽出
        console.log('メンションされたユーザーを抽出中...\n');
        const users = {};

        comments.forEach(comment => {
            console.log(`コメント内容: ${comment.content}`);
            // Todoist API のコメントレスポンスを確認
            console.log('コメント詳細:', JSON.stringify(comment, null, 2));
        });

    } catch (error) {
        console.error('エラー:', error.message);
    }
}

getUserIds();
