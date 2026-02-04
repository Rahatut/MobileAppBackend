const express = require('express');
const pool = require('../db/pool');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// Get all chats for current user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT DISTINCT c.*, 
              (SELECT content FROM Message WHERE chat_id = c.chat_id ORDER BY created_at DESC LIMIT 1) as last_message,
              (SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
               FROM Message WHERE chat_id = c.chat_id ORDER BY created_at DESC LIMIT 1) as last_message_time,
              (SELECT COUNT(*) FROM Message WHERE chat_id = c.chat_id AND is_read = false AND sender_id != $1) as unread_count
       FROM Chat c
       JOIN Chat_Participants cp ON c.chat_id = cp.chat_id
       WHERE cp.participant_id = $1
       ORDER BY last_message_time DESC
       LIMIT $2 OFFSET $3`,
      [req.userId, limit, offset]
    );

    res.json({ chats: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch chats' });
  }
});

// Get single chat with messages
router.get('/:chatId/messages', authMiddleware, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    // Verify user is participant
    const participantCheck = await pool.query(
      'SELECT * FROM Chat_Participants WHERE chat_id = $1 AND participant_id = $2',
      [chatId, req.userId]
    );

    if (participantCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const messages = await pool.query(
      `SELECT m.message_id,
              m.chat_id,
              m.sender_id,
              m.content,
              m.media_url,
              m.is_read,
              to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
              u.name,
              u.username,
              u.avatar_url
       FROM Message m
       JOIN "User" u ON m.sender_id = u.user_id
       WHERE m.chat_id = $1
       ORDER BY m.created_at DESC
       LIMIT $2 OFFSET $3`,
      [chatId, limit, offset]
    );

    // Mark messages as read
    await pool.query(
      'UPDATE Message SET is_read = true WHERE chat_id = $1 AND sender_id != $2 AND is_read = false',
      [chatId, req.userId]
    );

    res.json({ messages: messages.rows.reverse() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Create or get private chat between two users
router.post('/private/:otherUserId', authMiddleware, async (req, res) => {
  const client = await pool.connect();

  try {
    const { otherUserId } = req.params;

    if (parseInt(otherUserId) === req.userId) {
      return res.status(400).json({ error: 'Cannot chat with yourself' });
    }

    await client.query('BEGIN');

    // Check if private chat already exists
    const existingChat = await client.query(
      `SELECT c.* FROM Chat c
       JOIN Chat_Participants cp1 ON c.chat_id = cp1.chat_id
       JOIN Chat_Participants cp2 ON c.chat_id = cp2.chat_id
       WHERE c.type = 'private'
       AND cp1.participant_id = $1 AND cp2.participant_id = $2`,
      [req.userId, otherUserId]
    );

    if (existingChat.rows.length > 0) {
      await client.query('COMMIT');
      return res.json({ chat: existingChat.rows[0] });
    }

    // Create new private chat
    const chatResult = await client.query(
      `INSERT INTO Chat (type, created_by) VALUES ('private', $1) RETURNING *`,
      [req.userId]
    );

    const chat = chatResult.rows[0];

    // Add participants
    await client.query(
      `INSERT INTO Chat_Participants (chat_id, participant_id, role) VALUES 
       ($1, $2, 'creator'),
       ($1, $3, 'friend')`,
      [chat.chat_id, req.userId, otherUserId]
    );

    await client.query('COMMIT');

    res.status(201).json({ chat });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to create/get chat' });
  } finally {
    client.release();
  }
});

// Send message
router.post('/:chatId/messages', authMiddleware, async (req, res) => {
  const client = await pool.connect();

  try {
    const { chatId } = req.params;
    const { content, mediaUrl } = req.body;

    if (!content && !mediaUrl) {
      return res.status(400).json({ error: 'Message content or media is required' });
    }

    // Verify user is participant
    const participantCheck = await client.query(
      'SELECT * FROM Chat_Participants WHERE chat_id = $1 AND participant_id = $2',
      [chatId, req.userId]
    );

    if (participantCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO Message (chat_id, sender_id, content, media_url, is_read, created_at) 
       VALUES ($1, $2, $3, $4, false, CURRENT_TIMESTAMP) 
       RETURNING message_id,
                 chat_id,
                 sender_id,
                 content,
                 media_url,
                 is_read,
                 to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at`,
      [chatId, req.userId, content, mediaUrl]
    );

    await client.query('COMMIT');

    res.status(201).json({ message: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
  } finally {
    client.release();
  }
});

// Mark message as read
router.patch('/:chatId/messages/:messageId/read', authMiddleware, async (req, res) => {
  try {
    const { chatId, messageId } = req.params;

    // Verify user is participant
    const participantCheck = await pool.query(
      'SELECT * FROM Chat_Participants WHERE chat_id = $1 AND participant_id = $2',
      [chatId, req.userId]
    );

    if (participantCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const result = await pool.query(
      'UPDATE Message SET is_read = true WHERE message_id = $1 AND chat_id = $2 RETURNING *',
      [messageId, chatId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ message: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark message as read' });
  }
});

// Delete message (soft delete)
router.delete('/:chatId/messages/:messageId', authMiddleware, async (req, res) => {
  try {
    const { chatId, messageId } = req.params;

    // Verify message belongs to user
    const messageCheck = await pool.query(
      'SELECT sender_id FROM Message WHERE message_id = $1 AND chat_id = $2',
      [messageId, chatId]
    );

    if (messageCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    if (messageCheck.rows[0].sender_id !== req.userId) {
      return res.status(403).json({ error: 'Can only delete your own messages' });
    }

    const result = await pool.query(
      'UPDATE Message SET is_deleted = true WHERE message_id = $1 RETURNING *',
      [messageId]
    );

    res.json({ message: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Get chat details
router.get('/:chatId', authMiddleware, async (req, res) => {
  try {
    const { chatId } = req.params;

    // Verify user is participant
    const participantCheck = await pool.query(
      'SELECT * FROM Chat_Participants WHERE chat_id = $1 AND participant_id = $2',
      [chatId, req.userId]
    );

    if (participantCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const chatResult = await pool.query('SELECT * FROM Chat WHERE chat_id = $1', [chatId]);

    if (chatResult.rows.length === 0) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const participantsResult = await pool.query(
      `SELECT cp.*, u.name, u.username, u.avatar_url, u.phone
       FROM Chat_Participants cp
       JOIN "User" u ON cp.participant_id = u.user_id
       WHERE cp.chat_id = $1`,
      [chatId]
    );

    res.json({
      chat: chatResult.rows[0],
      participants: participantsResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch chat details' });
  }
});

module.exports = router;
