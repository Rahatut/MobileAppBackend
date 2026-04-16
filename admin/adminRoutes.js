const express = require('express');
const pool = require('../db/pool');
const authMiddleware = require('../middleware/auth');
const adminPrivilege = require('../middleware/adminPrivilege');
const { maskUser, maskRide } = require('../utils/maskSensitiveFields');
const auditLogAction = require('../utils/auditLogAction');

const router = express.Router();

// Admin: Get all users (with admin privileges)

router.get('/users', authMiddleware, adminPrivilege(), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM "User"');
    // Mask sensitive fields by default
    let users = result.rows.map(maskUser);

    // If ?unmask=1 and reason is provided, allow unmasking and log access
    const { unmask, reason } = req.query;
    if (unmask === '1' && reason && req.admin) {
      users = result.rows; // Unmasked
      // Log sensitive access
      await auditLogAction({
        adminId: req.admin.id,
        action: 'user_viewed',
        targetType: 'user',
        targetId: 'ALL',
        targetName: 'ALL',
        reason: String(reason),
        beforeState: 'masked',
        afterState: 'unmasked',
        sensitiveAccess: true,
        ipAddress: req.ip,
      });
    }
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Admin: Get all rides

router.get('/rides', authMiddleware, adminPrivilege(), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM Ride');
    let rides = result.rows.map(maskRide);

    const { unmask, reason } = req.query;
    if (unmask === '1' && reason && req.admin) {
      rides = result.rows;
      await auditLogAction({
        adminId: req.admin.id,
        action: 'ride_viewed',
        targetType: 'ride',
        targetId: 'ALL',
        targetName: 'ALL',
        reason: String(reason),
        beforeState: 'masked',
        afterState: 'unmasked',
        sensitiveAccess: true,
        ipAddress: req.ip,
      });
    }
    res.json(rides);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch rides' });
  }
});


// Admin: Get all join requests

router.get('/join-requests', authMiddleware, adminPrivilege(), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT jr.request_id, jr.ride_id, jr.partner_id, jr.start_location_id, jr.dest_location_id, jr.route_polyline, jr.timestamp,
             u.name as partner_name, u.username as partner_username,
             r.creator_id, r.start_time, r.transport_mode, r.fare, r.available_seats,
             (SELECT status FROM Request_Status_Log WHERE request_id = jr.request_id ORDER BY timestamp DESC LIMIT 1) as status
      FROM Join_Request jr
      JOIN "User" u ON jr.partner_id = u.user_id
      JOIN Ride r ON jr.ride_id = r.ride_id
      ORDER BY jr.timestamp DESC
    `);
    let joinRequests = result.rows;
    // Mask partner_name and other sensitive fields if needed
    const { unmask, reason } = req.query;
    if (!(unmask === '1' && reason && req.admin)) {
      joinRequests = joinRequests.map(jr => ({
        ...jr,
        partner_name: jr.partner_name ? jr.partner_name[0] + '***' : '',
      }));
    } else {
      await auditLogAction({
        adminId: req.admin.id,
        action: 'join_request_viewed',
        targetType: 'join_request',
        targetId: 'ALL',
        targetName: 'ALL',
        reason: String(reason),
        beforeState: 'masked',
        afterState: 'unmasked',
        sensitiveAccess: true,
        ipAddress: req.ip,
      });
    }
    res.json(joinRequests);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch join requests' });
  }
});

// Admin: Chat moderation (list all chats, delete message, ban user from chat, etc.)

router.get('/chats', authMiddleware, adminPrivilege(), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.chat_id, c.type, c.created_at, c.ride_id, r.creator_id, r.start_time
      FROM Chat c
      LEFT JOIN Ride r ON c.ride_id = r.ride_id
      ORDER BY c.created_at DESC
      LIMIT 100
    `);
    let chats = result.rows;
    const { unmask, reason } = req.query;
    if (!(unmask === '1' && reason && req.admin)) {
      chats = chats.map(c => ({
        ...c,
        type: c.type ? c.type[0] + '***' : '',
      }));
    } else {
      await auditLogAction({
        adminId: req.admin.id,
        action: 'chat_viewed',
        targetType: 'chat',
        targetId: 'ALL',
        targetName: 'ALL',
        reason: String(reason),
        beforeState: 'masked',
        afterState: 'unmasked',
        sensitiveAccess: true,
        ipAddress: req.ip,
      });
    }
    res.json(chats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch chats' });
  }
});

router.delete('/chats/:chatId/messages/:messageId', authMiddleware, adminPrivilege(), async (req, res) => {
  const { chatId, messageId } = req.params;
  try {
    await pool.query('UPDATE Message SET is_deleted = true WHERE chat_id = $1 AND message_id = $2', [chatId, messageId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Admin: Safety/Incidents

router.get('/incidents', authMiddleware, adminPrivilege(), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pr.report_id, pr.ride_id, pr.request_id, pr.reporter_user_id, ru.name as reporter_name, ru.username as reporter_username,
             pr.reported_user_id, rdu.name as reported_name, rdu.username as reported_username,
             pr.reason, pr.details, pr.created_at
      FROM Passenger_Report pr
      LEFT JOIN "User" ru ON pr.reporter_user_id = ru.user_id
      LEFT JOIN "User" rdu ON pr.reported_user_id = rdu.user_id
      ORDER BY pr.created_at DESC
      LIMIT 200
    `);
    let incidents = result.rows;
    const { unmask, reason } = req.query;
    if (!(unmask === '1' && reason && req.admin)) {
      incidents = incidents.map(i => ({
        ...i,
        reason: i.reason ? i.reason[0] + '***' : '',
        details: i.details ? i.details.slice(0, 10) + '...' : '',
      }));
    } else {
      await auditLogAction({
        adminId: req.admin.id,
        action: 'incident_viewed',
        targetType: 'incident',
        targetId: 'ALL',
        targetName: 'ALL',
        reason: String(reason),
        beforeState: 'masked',
        afterState: 'unmasked',
        sensitiveAccess: true,
        ipAddress: req.ip,
      });
    }
    res.json(incidents);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch incidents' });
  }
});

router.post('/incidents/:incidentId/resolve', authMiddleware, adminPrivilege(), async (req, res) => {
  // For demo, just delete the report (in production, mark as resolved instead)
  const { incidentId } = req.params;
  try {
    await pool.query('DELETE FROM Passenger_Report WHERE report_id = $1', [incidentId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to resolve incident' });
  }
});

// Admin: Notifications management

router.get('/notifications', authMiddleware, adminPrivilege(), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT n.notification_id, n.user_id, u.name as user_name, u.username as user_username, n.type, n.message, n.is_read, n.created_at
      FROM Notification n
      LEFT JOIN "User" u ON n.user_id = u.user_id
      ORDER BY n.created_at DESC
      LIMIT 200
    `);
      let notifications = result.rows;
      const { unmask, reason } = req.query;
      // Mask notification message if not unmasked with reason
      if (!(unmask === '1' && reason && req.admin)) {
        notifications = notifications.map(n => ({
          ...n,
          message: n.message ? n.message.slice(0, 10) + '...' : '',
        }));
      } else {
        await auditLogAction({
          adminId: req.admin.id,
          action: 'notification_viewed',
          targetType: 'notification',
          targetId: 'ALL',
          targetName: 'ALL',
          reason: String(reason),
          beforeState: 'masked',
          afterState: 'unmasked',
          sensitiveAccess: true,
          ipAddress: req.ip,
        });
      }
      res.json(notifications);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

router.post('/notifications/send', authMiddleware, adminPrivilege(), async (req, res) => {
  const { user_id, type, message } = req.body;
  if (!user_id || !type || !message) {
    return res.status(400).json({ error: 'user_id, type, and message are required' });
  }
  try {
    await pool.query(
      'INSERT INTO Notification (user_id, type, message) VALUES ($1, $2, $3)',
      [user_id, type, message]
    );
    res.json({ success: true });
  } catch (err) {
      const { unmask, reason } = req.query;
    console.error(err);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// Admin: Audit logs

router.get('/audit-logs', authMiddleware, adminPrivilege(), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.audit_id, a.action, a.actor_user_id, u.name as actor_name, u.username as actor_username,
             a.target_request_id, a.target_ride_id, a.details, a.created_at
      FROM Audit_Log a
      LEFT JOIN "User" u ON a.actor_user_id = u.user_id
      ORDER BY a.created_at DESC
      LIMIT 200
    `);
    let logs = result.rows;
    if (!(unmask === '1' && reason && req.admin)) {
      logs = logs.map(l => ({
        ...l,
        action: l.action ? l.action[0] + '***' : '',
        details: l.details ? l.details.slice(0, 10) + '...' : '',
      }));
    } else {
      await auditLogAction({
        adminId: req.admin.id,
        action: 'audit_log_viewed',
        targetType: 'audit_log',
        targetId: 'ALL',
        targetName: 'ALL',
        reason: String(reason),
        beforeState: 'masked',
        afterState: 'unmasked',
        sensitiveAccess: true,
        ipAddress: req.ip,
      });
    }
    res.json(logs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// Admin: System repair

router.get('/repair', authMiddleware, adminPrivilege(), async (req, res) => {
  // No repair table in schema, so return empty array for now
  try {
    const result = await pool.query('SELECT * FROM Repair_Request ORDER BY created_at DESC LIMIT 200');
    let repairs = result.rows;
    const { unmask, reason } = req.query;
    if (!(unmask === '1' && reason && req.admin)) {
      repairs = repairs.map(r => ({
        ...r,
        description: r.description ? r.description.slice(0, 10) + '...' : '',
        contact: r.contact ? r.contact[0] + '***' : '',
      }));
    } else {
      await auditLogAction({
        adminId: req.admin.id,
        action: 'repair_viewed',
        targetType: 'repair',
        targetId: 'ALL',
        targetName: 'ALL',
        reason: String(reason),
        beforeState: 'masked',
        afterState: 'unmasked',
        sensitiveAccess: true,
        ipAddress: req.ip,
      });
    }
    res.json(repairs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch repair requests' });
  }
});

router.post('/repair/:repairId/resolve', authMiddleware, adminPrivilege(), async (req, res) => {
  // No repair table in schema, so just return success for now
  res.json({ success: true });
});

module.exports = router;
