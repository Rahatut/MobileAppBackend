const express = require('express');
const pool = require('../db/pool');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

async function getChatMeta(client, chatId) {
  const result = await client.query('SELECT chat_id, type, ride_id FROM Chat WHERE chat_id = $1', [chatId]);
  return result.rows[0] || null;
}

async function getRideMemberStatus(client, rideId, userId) {
  const result = await client.query(
    `SELECT
       CASE 
         WHEN r.creator_id = $2 THEN 'creator'
         WHEN jr.request_id IS NOT NULL THEN COALESCE(
           (SELECT status::text 
            FROM Request_Status_Log 
            WHERE request_id = jr.request_id 
            ORDER BY timestamp DESC LIMIT 1),
           jr.status::text
         )
         ELSE NULL
       END as membership_status,
       CASE
         WHEN jr.request_id IS NOT NULL THEN EXISTS (
           SELECT 1 FROM Request_Status_Log 
           WHERE request_id = jr.request_id AND status = 'accepted'
         )
         ELSE FALSE
       END as was_ever_accepted
     FROM Ride r
     LEFT JOIN Join_Request jr ON jr.ride_id = r.ride_id AND jr.partner_id = $2
     WHERE r.ride_id = $1`,
    [rideId, userId]
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0];

  if (row.membership_status === 'creator') return 'creator';
  if (row.membership_status === 'accepted') return 'active_passenger';
  if (row.was_ever_accepted) return 'removed_passenger';

  return null;
}

async function canUsersDirectMessage(client, userA, userB) {
  const result = await client.query(
    `SELECT 1
     WHERE EXISTS (
       SELECT 1
       FROM Ride r
       WHERE r.creator_id IN ($1, $2)
         AND (
           EXISTS (
             SELECT 1 FROM Join_Request j1
             WHERE j1.ride_id = r.ride_id
               AND j1.partner_id = $1
               AND COALESCE(
                 (SELECT status FROM Request_Status_Log WHERE request_id = j1.request_id ORDER BY timestamp DESC LIMIT 1),
                 j1.status
               ) IN ('accepted', 'pending')
           )
           OR EXISTS (
             SELECT 1 FROM Join_Request j2
             WHERE j2.ride_id = r.ride_id
               AND j2.partner_id = $2
               AND COALESCE(
                 (SELECT status FROM Request_Status_Log WHERE request_id = j2.request_id ORDER BY timestamp DESC LIMIT 1),
                 j2.status
               ) IN ('accepted', 'pending')
           )
         )
     )
     OR EXISTS (
       SELECT 1
       FROM Join_Request a
       JOIN Join_Request b ON a.ride_id = b.ride_id
       WHERE a.partner_id = $1
         AND b.partner_id = $2
         AND COALESCE(
           (SELECT status FROM Request_Status_Log WHERE request_id = a.request_id ORDER BY timestamp DESC LIMIT 1),
           a.status
         ) = 'accepted'
         AND COALESCE(
           (SELECT status FROM Request_Status_Log WHERE request_id = b.request_id ORDER BY timestamp DESC LIMIT 1),
           b.status
         ) = 'accepted'
     )`,
    [userA, userB]
  );

  return result.rows.length > 0;
}

async function isAuthorizedForChat(client, chatId, userId) {
  const chat = await getChatMeta(client, chatId);
  if (!chat) {
    return { ok: false, reason: 'Chat not found', status: 404 };
  }

  // For ride chats, enforce dynamic membership based on ride/join status.
  if (chat.type === 'ride' && chat.ride_id) {
    const memberStatus = await getRideMemberStatus(client, chat.ride_id, userId);
    if (!memberStatus) {
      return { ok: false, reason: 'Not authorized for this ride chat', status: 403 };
    }
    return {
      ok: true,
      chat,
      memberStatus,
      isActiveMember: memberStatus === 'creator' || memberStatus === 'active_passenger'
    };
  }

  // For private chats, require Chat_Participants membership.
  const participantCheck = await client.query(
    'SELECT 1 FROM Chat_Participants WHERE chat_id = $1 AND participant_id = $2',
    [chatId, userId]
  );

  if (participantCheck.rows.length === 0) {
    return { ok: false, reason: 'Not authorized', status: 403 };
  }

  return { ok: true, chat };
}

// Get all chats for current user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, type } = req.query;
    const offset = (page - 1) * limit;

    const typeFilter = type === 'ride' || type === 'private' ? type : null;

    const result = await pool.query(
      `SELECT DISTINCT c.*,
              r.ride_id,
              sl.name as ride_start_name,
              dl.name as ride_dest_name,
              (SELECT content FROM Message WHERE chat_id = c.chat_id ORDER BY created_at DESC LIMIT 1) as last_message,
              (SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
               FROM Message WHERE chat_id = c.chat_id ORDER BY created_at DESC LIMIT 1) as last_message_time,
              (SELECT COUNT(*) FROM Message WHERE chat_id = c.chat_id AND is_read = false AND sender_id != $1) as unread_count
       FROM Chat c
       LEFT JOIN Ride r ON c.ride_id = r.ride_id
       LEFT JOIN Location_Info sl ON r.start_location_id = sl.location_id
       LEFT JOIN Location_Info dl ON r.dest_location_id = dl.location_id
       JOIN Chat_Participants cp ON c.chat_id = cp.chat_id
       WHERE cp.participant_id = $1
         AND ($2::text IS NULL OR c.type = $2::chat_type_enum)
         AND (
            c.type != 'ride'
            OR c.ride_id IS NULL
            OR r.creator_id = $1
            OR EXISTS (
              SELECT 1
              FROM Join_Request jr
              WHERE jr.ride_id = c.ride_id
                AND jr.partner_id = $1
                AND EXISTS (
                  SELECT 1 FROM Request_Status_Log rsl 
                  WHERE rsl.request_id = jr.request_id 
                    AND rsl.status = 'accepted'
                )
            )
         )
       ORDER BY last_message_time DESC
       LIMIT $3 OFFSET $4`,
      [req.userId, typeFilter, limit, offset]
    );

    const chats = result.rows.map((row) => ({
      ...row,
      ride_name:
        row.type === 'ride' && row.ride_start_name && row.ride_dest_name
          ? `${row.ride_start_name} -> ${row.ride_dest_name}`
          : null,
    }));

    res.json({ chats });
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

    const authz = await isAuthorizedForChat(pool, chatId, req.userId);
    if (!authz.ok) {
      return res.status(authz.status).json({ error: authz.reason });
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
    const parsedOtherUserId = Number(otherUserId);

    if (!Number.isInteger(parsedOtherUserId) || parsedOtherUserId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    if (parsedOtherUserId === req.userId) {
      return res.status(400).json({ error: 'Cannot chat with yourself' });
    }

    const userResult = await client.query('SELECT user_id FROM "User" WHERE user_id = $1', [parsedOtherUserId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await client.query('BEGIN');

    // Check if private chat already exists
    const existingChat = await client.query(
      `SELECT c.* FROM Chat c
       JOIN Chat_Participants cp1 ON c.chat_id = cp1.chat_id
       JOIN Chat_Participants cp2 ON c.chat_id = cp2.chat_id
       WHERE c.type = 'private'
       AND cp1.participant_id = $1 AND cp2.participant_id = $2`,
      [req.userId, parsedOtherUserId]
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
      [chat.chat_id, req.userId, parsedOtherUserId]
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

    const authz = await isAuthorizedForChat(client, chatId, req.userId);
    if (!authz.ok) {
      return res.status(authz.status).json({ error: authz.reason });
    }

    if (authz.chat && authz.chat.type === 'ride') {
      if (!authz.isActiveMember) {
        return res.status(403).json({ error: 'You are no longer an active participant in this ride' });
      }
      
      const rideStatusRes = await client.query(
        `SELECT status FROM Ride_Status_Log WHERE ride_id = $1 ORDER BY timestamp DESC LIMIT 1`,
        [authz.chat.ride_id]
      );
      const rideStatus = rideStatusRes.rows.length > 0 ? rideStatusRes.rows[0].status : 'unactive';
      
      if (rideStatus === 'completed' || rideStatus === 'cancelled') {
        return res.status(403).json({ error: 'This chat is now read-only because the ride is completed or cancelled' });
      }
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

    // Notify other participants
    const otherParticipants = await client.query(
      'SELECT participant_id FROM Chat_Participants WHERE chat_id = $1 AND participant_id != $2',
      [chatId, req.userId]
    );

    const senderResult = await client.query('SELECT name FROM "User" WHERE user_id = $1', [req.userId]);
    const senderName = senderResult.rows[0]?.name || 'Someone';

    for (const participant of otherParticipants.rows) {
      await client.query(
        `INSERT INTO Notification (user_id, type, message, related_user_id)
         VALUES ($1, 'message', $2, $3)`,
        [participant.participant_id, `New message from ${senderName}: ${content || 'Media'}`, req.userId]
      );
    }

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

    const authz = await isAuthorizedForChat(pool, chatId, req.userId);
    if (!authz.ok) {
      return res.status(authz.status).json({ error: authz.reason });
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

    const authz = await isAuthorizedForChat(pool, chatId, req.userId);
    if (!authz.ok) {
      return res.status(authz.status).json({ error: authz.reason });
    }

    if (authz.chat && authz.chat.type === 'ride') {
      if (!authz.isActiveMember) {
        return res.status(403).json({ error: 'You are no longer an active participant in this ride' });
      }
      
      const rideStatusRes = await pool.query(
        `SELECT status FROM Ride_Status_Log WHERE ride_id = $1 ORDER BY timestamp DESC LIMIT 1`,
        [authz.chat.ride_id]
      );
      const rideStatus = rideStatusRes.rows.length > 0 ? rideStatusRes.rows[0].status : 'unactive';
      
      if (rideStatus === 'completed' || rideStatus === 'cancelled') {
        return res.status(403).json({ error: 'This chat is now read-only because the ride is completed or cancelled' });
      }
    }

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

    const authz = await isAuthorizedForChat(pool, chatId, req.userId);
    if (!authz.ok) {
      return res.status(authz.status).json({ error: authz.reason });
    }

    const chatResult = await pool.query('SELECT * FROM Chat WHERE chat_id = $1', [chatId]);

    if (chatResult.rows.length === 0) {
      return res.status(404).json({ error: 'Chat not found' });
    }
    
    const chat = chatResult.rows[0];

    const participantsResult = await pool.query(
      `SELECT cp.*, u.name, u.username, u.avatar_url, u.phone,
              CASE 
                WHEN cp.role = 'creator' THEN 'creator'
                WHEN $2 = 'ride' THEN (
                   SELECT rsl.status::text 
                   FROM Join_Request jr 
                   JOIN Request_Status_Log rsl ON jr.request_id = rsl.request_id
                   WHERE jr.ride_id = $3 AND jr.partner_id = cp.participant_id
                   ORDER BY rsl.timestamp DESC LIMIT 1
                )
                ELSE 'active'
              END as ride_status
       FROM Chat_Participants cp
       JOIN "User" u ON cp.participant_id = u.user_id
       WHERE cp.chat_id = $1`,
      [chatId, chat.type, chat.ride_id || null]
    );

    res.json({
      chat: chat,
      participants: participantsResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch chat details' });
  }
});

module.exports = router;
