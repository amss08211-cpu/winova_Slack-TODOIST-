/**
 * foresma ワークスペース用ルート
 */

const express = require('express');
const router = express.Router();
const { handleCommand, handleInteractivity, rawBodyParser } = require('../../lib/handlers/slack');

const WORKSPACE_ID = 'foresma';

// コマンド
router.post('/command', rawBodyParser, (req, res) => {
  handleCommand(req, res, WORKSPACE_ID);
});

// Interactivity
router.post('/interactivity', (req, res) => {
  handleInteractivity(req, res, WORKSPACE_ID);
});

module.exports = router;
