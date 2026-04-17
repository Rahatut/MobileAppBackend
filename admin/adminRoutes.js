const express = require('express');
const pool = require('../db/pool');
const adminAuth = require('../middleware/adminAuth');
const { maskUser, maskRide } = require('../utils/maskSensitiveFields');
const auditLogAction = require('../utils/auditLogAction');

const router = express.Router();

router.get('/users', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.user_id::text as id, u.name, u.username, a.email, u.phone, 
             CASE WHEN u.is_active THEN 'active' ELSE 'suspended' END as status,
             100 as "trustScore",
             u.created_at as "joinedAt", u.updated_at as "lastActive",
             u.total_rides as "ridesCount", u.avg_rating as rating,
             0 as flags
      FROM "User" u
      LEFT JOIN auth a ON u.user_id = a.user_id
    `);
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

router.get('/rides', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.ride_id::text as id, 
             loc_start.name as from, loc_dest.name as to,
             r.creator_id::text as "creatorId", u.name as "creatorName", u.phone as "creatorContact",
             r.transport_mode as transport, r.start_time as "departureTime",
             r.available_seats as seats,
             (SELECT COUNT(*) FROM join_request WHERE ride_id = r.ride_id AND status = 'accepted') as "currentPassengers",
             r.status,
             (SELECT COUNT(*) FROM passenger_report WHERE ride_id = r.ride_id) as "reportCount",
             '[]'::json as flags,
             '[]'::json as "participantIds",
             r.fare
      FROM ride r
      LEFT JOIN "User" u ON r.creator_id = u.user_id
      LEFT JOIN location_info loc_start ON r.start_location_id = loc_start.location_id
      LEFT JOIN location_info loc_dest ON r.dest_location_id = loc_dest.location_id
    `);
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

router.get('/join-requests', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT jr.request_id::text as id, jr.partner_id::text as "requesterId", u.name as "requesterName",
             jr.ride_id::text as "rideId", (COALESCE(loc_start.name, 'Origin') || ' -> ' || COALESCE(loc_dest.name, 'Dest')) as "rideName",
             jr.status,
             COALESCE((SELECT psl.status FROM payment p JOIN payment_status_log psl ON p.payment_id = psl.payment_id WHERE p.ride_id = jr.ride_id AND p.payer_id = jr.partner_id ORDER BY psl.timestamp DESC LIMIT 1), 'pending') as "paymentStatus",
             jr.timestamp as "requestedAt",
             false as "repairNeeded",
             u.name as partner_name
      FROM join_request jr
      LEFT JOIN "User" u ON jr.partner_id = u.user_id
      LEFT JOIN ride r ON jr.ride_id = r.ride_id
      LEFT JOIN location_info loc_start ON r.start_location_id = loc_start.location_id
      LEFT JOIN location_info loc_dest ON r.dest_location_id = loc_dest.location_id
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

router.get('/chats', adminAuth, async (req, res) => {
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

router.delete('/chats/:chatId/messages/:messageId', adminAuth, async (req, res) => {
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

router.get('/incidents', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT pr.report_id::text as id, 'abuse_report' as type, 'medium' as severity, 'open' as status,
             pr.ride_id::text as "rideId", pr.request_id, pr.reporter_user_id::text as "reporterId", ru.name as "reporterName", ru.username as reporter_username,
             pr.reported_user_id::text as "targetId", rdu.name as "targetName", rdu.username as reported_username,
             pr.reason, pr.details as description, pr.created_at as "reportedAt"
      FROM passenger_report pr
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

router.post('/incidents/:incidentId/resolve', adminAuth, async (req, res) => {
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

router.get('/notifications', adminAuth, async (req, res) => {
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

router.post('/notifications/send', adminAuth, async (req, res) => {
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

router.get('/audit-logs', adminAuth, async (req, res) => {
  // No Audit_Log table; return empty array or optionally read from file
  res.json([]);
});

// Admin: System repair

router.get('/repair', adminAuth, async (req, res) => {
  // No repair table in schema, so return empty array for now
  res.json([]);
});

router.post('/repair/:repairId/resolve', adminAuth, async (req, res) => {
  // No repair table in schema, so just return success for now
  res.json({ success: true });
});

// Admin: Metrics (Dynamic + System mock)
router.get('/metrics/active-rides-chart', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT TO_CHAR(start_time, 'HH24:00') as hour, COUNT(*) as rides
      FROM Ride
      WHERE start_time >= NOW() - INTERVAL '24 HOURS'
      GROUP BY TO_CHAR(start_time, 'HH24:00')
      ORDER BY hour ASC
    `);
    let chartData = result.rows.map(r => ({ ...r, rides: parseInt(r.rides, 10) }));
    if (chartData.length === 0) {
      chartData = Array.from({length: 24}, (_, i) => ({ hour: `${i.toString().padStart(2, '0')}:00`, rides: 0 }));
    }
    res.json(chartData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch active rides chart' });
  }
});

router.get('/metrics/report-types-chart', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT reason as name, COUNT(*) as value
      FROM Passenger_Report
      GROUP BY reason
    `);
    let data = result.rows.map(r => ({ name: r.name, value: parseInt(r.value, 10) }));
    if (data.length === 0) data = [{ name: 'No Reports', value: 1 }];
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch report types chart' });
  }
});

router.get('/metrics/active-users-chart', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as date, COUNT(*) as users
      FROM "User"
      WHERE created_at >= NOW() - INTERVAL '7 DAYS'
      GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD')
      ORDER BY date ASC
    `);
    res.json(result.rows.map(r => ({ ...r, users: parseInt(r.users, 10) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch active users chart' });
  }
});

router.get('/metrics/system', adminAuth, async (req, res) => {
  res.json([
    { label: 'Cloud DB Storage', value: 42, unit: '%', status: 'good', trend: 'up' },
    { label: 'Server Memory (RAM)', value: 78, unit: '%', status: 'warning', trend: 'up' },
    { label: 'CPU Usage', value: 34, unit: '%', status: 'good', trend: 'down' },
    { label: 'API Error Rate (5xx)', value: 0.2, unit: '%', status: 'good', trend: 'down' }
  ]);
});

module.exports = router;
