/**
 * winova ワークスペース用ルート
 */

const express = require('express');
const router = express.Router();
const { handleCommand, handleInteractivity, rawBodyParser } = require('../../lib/handlers/slack');

const WORKSPACE_ID = 'winova';

// コマンド
router.post('/command', rawBodyParser, async (req, res) => {
  await handleCommand(req, res, WORKSPACE_ID);
});

// Interactivity（bodyパーサーが必要）
router.post('/interactivity', express.urlencoded({ extended: true }), async (req, res) => {
  await handleInteractivity(req, res, WORKSPACE_ID);
});

module.exports = router;
