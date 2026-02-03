const express = require('express');
const pool = require('../db/pool');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// Get user notifications with optional filtering
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { isRead = 'false', limit = 20, offset = 0 } = req.query;
    const isReadBool = isRead === 'true';
    const pageLimit = Math.min(parseInt(limit) || 20, 100);
    const pageOffset = parseInt(offset) || 0;

    let query = `
      SELECT n.*, 
             u.name as user_name, u.username as user_username, u.avatar_url as user_avatar,
             r.start_time as ride_start_time, r.transport_mode as ride_transport
      FROM Notification n
      LEFT JOIN "User" u ON n.related_user_id = u.user_id
      LEFT JOIN Ride r ON n.related_ride_id = r.ride_id
      WHERE n.user_id = $1
    `;

    const params = [req.userId];

    if (isRead !== 'all') {
      query += ` AND n.is_read = $${params.length + 1}`;
      params.push(isReadBool);
    }

    query += ` ORDER BY n.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(pageLimit, pageOffset);

    const result = await pool.query(query, params);

    // Get total unread count
    const countResult = await pool.query(
      `SELECT COUNT(*) as unread_count FROM Notification WHERE user_id = $1 AND is_read = false`,
      [req.userId]
    );

    res.json({
      notifications: result.rows,
      unreadCount: parseInt(countResult.rows[0].unread_count),
      total: result.rows.length,
      limit: pageLimit,
      offset: pageOffset,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Mark notification as read
router.patch('/:notificationId/read', authMiddleware, async (req, res) => {
  try {
    const { notificationId } = req.params;

    // Verify ownership
    const checkResult = await pool.query(
      `SELECT user_id FROM Notification WHERE notification_id = $1`,
      [notificationId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    if (checkResult.rows[0].user_id !== req.userId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const result = await pool.query(
      `UPDATE Notification SET is_read = true WHERE notification_id = $1 RETURNING *`,
      [notificationId]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

// Delete notification
router.delete('/:notificationId', authMiddleware, async (req, res) => {
  try {
    const { notificationId } = req.params;

    // Verify ownership
    const checkResult = await pool.query(
      `SELECT user_id FROM Notification WHERE notification_id = $1`,
      [notificationId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    if (checkResult.rows[0].user_id !== req.userId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await pool.query(
      `DELETE FROM Notification WHERE notification_id = $1`,
      [notificationId]
    );

    res.json({ message: 'Notification deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

// Mark all notifications as read
router.patch('/mark-all/read', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE Notification SET is_read = true 
       WHERE user_id = $1 AND is_read = false
       RETURNING *`,
      [req.userId]
    );

    res.json({ 
      message: 'All notifications marked as read',
      updatedCount: result.rowCount
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

// Create notification (internal use - not exposed to frontend directly)
router.post('/', async (req, res) => {
  try {
    const { userId, type, message, relatedUserId, relatedRideId } = req.body;

    if (!userId || !type || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await pool.query(
      `INSERT INTO Notification (user_id, type, message, related_user_id, related_ride_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, type, message, relatedUserId || null, relatedRideId || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create notification' });
  }
});

module.exports = router;
