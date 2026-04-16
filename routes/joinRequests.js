const express = require('express');
const pool = require('../db/pool');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const JOIN_BLOCKED_RIDE_STATUSES = new Set(['started', 'cancelled', 'completed', 'expired']);

function toDateSafe(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const hasTimezone = /(?:[zZ]|[+-]\d{2}:\d{2})$/.test(trimmed);
    const normalized = hasTimezone ? trimmed : `${trimmed.replace(' ', 'T')}Z`;
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function hasRideReachedJoinCutoff(startTime) {
  const startsAt = toDateSafe(startTime);
  if (!startsAt) {
    return true;
  }
  return startsAt <= new Date();
}

// Simple GET endpoint for /join-requests (must be after router is defined)
router.get('/', (req, res) => {
  res.json({ status: 'JoinRequests endpoint is reachable.' });
});

// Helper function to add request status
async function addRequestStatus(client, requestId, status) {
  await client.query(
    'INSERT INTO Request_Status_Log (request_id, status) VALUES ($1, $2)',
    [requestId, status]
  );
  await client.query(
    'UPDATE Join_Request SET status = $1 WHERE request_id = $2',
    [status, requestId]
  );
}

// Helper function to get current request status
async function getCurrentRequestStatus(client, requestId) {
  const result = await client.query(
    `SELECT status FROM Join_Request WHERE request_id = $1`,
    [requestId]
  );
  if (result.rows.length > 0 && result.rows[0].status) {
    return result.rows[0].status;
  }
  // Fallback to log
  const logResult = await client.query(
    `SELECT status FROM Request_Status_Log 
     WHERE request_id = $1 
     ORDER BY timestamp DESC LIMIT 1`,
    [requestId]
  );
  return logResult.rows.length > 0 ? logResult.rows[0].status : null;
}

async function getRideJoinInfo(client, rideId) {
  const result = await client.query(
    `SELECT r.ride_id, r.creator_id, r.available_seats, r.start_time,
            to_char(r.start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as start_time_utc,
            r.start_location_id, r.dest_location_id, r.route_polyline,
            COALESCE(
              (SELECT status FROM Ride_Status_Log WHERE ride_id = r.ride_id ORDER BY timestamp DESC LIMIT 1),
              'unactive'
            ) as current_status
     FROM Ride r
     WHERE r.ride_id = $1`,
    [rideId]
  );

  return result.rows[0] || null;
}

// Helper function to get or create location
async function getOrCreateLocation(client, name, latitude, longitude) {
  const result = await client.query(
    'SELECT location_id FROM Location_Info WHERE latitude = $1 AND longitude = $2',
    [latitude, longitude]
  );

  if (result.rows.length > 0) {
    return result.rows[0].location_id;
  }

  const insertResult = await client.query(
    'INSERT INTO Location_Info (name, address, latitude, longitude, geom) VALUES ($1, $2, $3::numeric, $4::numeric, ST_SetSRID(ST_MakePoint($4::double precision, $3::double precision), 4326)) RETURNING location_id',
    [name, name, latitude, longitude]
  );

  return insertResult.rows[0].location_id;
}

// Submit a join request
router.post('/', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { rideId, startLocation, endLocation, routePolyline } = req.body;

    if (!rideId) {
      return res.status(400).json({ error: 'rideId required' });
    }

    await client.query('BEGIN');

    // Check if user already has a join request for this ride
    const existingRequest = await client.query(
      `SELECT jr.request_id, 
              (SELECT status FROM Request_Status_Log WHERE request_id = jr.request_id ORDER BY timestamp DESC LIMIT 1) as status
       FROM Join_Request jr
       WHERE jr.ride_id = $1 AND jr.partner_id = $2`,
      [rideId, req.userId]
    );

    if (existingRequest.rows.length > 0) {
      const status = existingRequest.rows[0].status;
      if (status === 'accepted') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'You have already joined this ride' });
      } else if (status === 'pending') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'You have already requested to join this ride' });
      } else if (status === 'rejected') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Your previous request was declined' });
      } else if (status === 'cancelled') {
        // User cancelled, so allow them to request again.
      }
    }

    // Check ride joinability and available seats
    const rideResult = await getRideJoinInfo(client, rideId);

    if (!rideResult) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ride not found' });
    }

    if (Number(rideResult.creator_id) === Number(req.userId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You cannot join your own ride' });
    }

    if (JOIN_BLOCKED_RIDE_STATUSES.has(rideResult.current_status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This ride is no longer accepting join requests' });
    }

    if (hasRideReachedJoinCutoff(rideResult.start_time_utc || rideResult.start_time)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This ride has reached its join cutoff' });
    }

    if (rideResult.available_seats < 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No seats available' });
    }

    // ENFORCE GENDER/VISIBILITY RESTRICTIONS
    if (rideResult.gender_preference && rideResult.gender_preference.toLowerCase() === 'female') {
      // Fetch user gender
      const userResult = await client.query('SELECT gender FROM "User" WHERE user_id = $1', [req.userId]);
      const userGender = userResult.rows[0]?.gender;
      if (!userGender || userGender.toLowerCase() !== 'female') {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'This ride is restricted to female participants only.' });
      }
    }

    // Create locations if provided
    let startLocationId = rideResult.start_location_id;
    let destLocationId = rideResult.dest_location_id;

    if (startLocation) {
      startLocationId = await getOrCreateLocation(
        client,
        startLocation.name || startLocation.address,
        startLocation.latitude !== undefined ? startLocation.latitude : startLocation.lat,
        startLocation.longitude !== undefined ? startLocation.longitude : startLocation.lng
      );
    }

    if (endLocation) {
      destLocationId = await getOrCreateLocation(
        client,
        endLocation.name || endLocation.address,
        endLocation.latitude !== undefined ? endLocation.latitude : endLocation.lat,
        endLocation.longitude !== undefined ? endLocation.longitude : endLocation.lng
      );
    }

    let parsedRoutePolyline = null;
    if (routePolyline) {
      let parsed = typeof routePolyline === 'string' ? JSON.parse(routePolyline) : routePolyline;
      if (parsed && parsed.coordinates) {
         parsedRoutePolyline = JSON.stringify({
           type: 'LineString',
           coordinates: parsed.coordinates
         });
      } else {
         parsedRoutePolyline = JSON.stringify(parsed);
      }
    } else {
      parsedRoutePolyline = rideResult.route_polyline;
    }


    // Insert join request
    const result = await client.query(
      `INSERT INTO Join_Request (ride_id, partner_id, start_location_id, dest_location_id, route_polyline, status) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING *`,
      [
        rideId, 
        req.userId, 
        startLocationId, 
        destLocationId, 
        parsedRoutePolyline,
        'pending'
      ]
    );

    const joinRequest = result.rows[0];

    // AUDIT LOG: join request submitted
    await client.query(
      `INSERT INTO Audit_Log (action, actor_user_id, target_request_id, target_ride_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        'join_request_submitted',
        req.userId,
        joinRequest.request_id,
        rideId,
        JSON.stringify({ startLocationId, destLocationId })
      ]
    );

    // Add initial status
    await addRequestStatus(client, joinRequest.request_id, 'pending');

    // Create notification for ride creator
    console.log('Creating notification for ride creator:', rideResult.creator_id);
    console.log('Join request ID:', joinRequest.request_id);

    const requesterResult = await client.query(
      'SELECT name FROM "User" WHERE user_id = $1',
      [req.userId]
    );
    const requesterName = requesterResult.rows[0]?.name || 'Someone';

    const notificationResult = await client.query(
      `INSERT INTO Notification (user_id, type, message, related_ride_id, related_request_id, related_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        rideResult.creator_id,
        'join_request',
        `${requesterName} wants to join your ride`,
        rideId,
        joinRequest.request_id,
        req.userId,
      ]
    );
    
    console.log('✅ Notification created:', notificationResult.rows[0]);

    // Also create a confirmation notification for the requester
    await client.query(
      `INSERT INTO Notification (user_id, type, message, related_ride_id, related_request_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.userId,
        'join_request_sent',
        'Your join request has been sent. Waiting for the ride creator to respond.',
        rideId,
        joinRequest.request_id,
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Join request submitted',
      joinRequest,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Already requested to join this ride' });
    }
    res.status(500).json({ error: 'Failed to submit join request' });
  } finally {
    client.release();
  }
});

// Get join requests for a ride (creator only)
router.get('/ride/:rideId', authMiddleware, async (req, res) => {
  try {
    // Verify ownership
    const rideResult = await pool.query('SELECT creator_id FROM Ride WHERE ride_id = $1', [req.params.rideId]);

    if (rideResult.rows.length === 0) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    if (Number(rideResult.rows[0].creator_id) !== Number(req.userId)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const result = await pool.query(
      `SELECT jr.*, u.name, u.username, u.user_uuid, u.avatar_url, u.avg_rating,
              sl.name as start_name, sl.latitude as start_lat, sl.longitude as start_lng,
              dl.name as dest_name, dl.latitude as dest_lat, dl.longitude as dest_lng,
              (SELECT status FROM Request_Status_Log WHERE request_id = jr.request_id ORDER BY timestamp DESC LIMIT 1) as current_status
       FROM Join_Request jr
       JOIN "User" u ON jr.partner_id = u.user_id
       LEFT JOIN Location_Info sl ON jr.start_location_id = sl.location_id
       LEFT JOIN Location_Info dl ON jr.dest_location_id = dl.location_id
       WHERE jr.ride_id = $1
       ORDER BY jr.timestamp DESC`,
      [req.params.rideId]
    );

    res.json({ joinRequests: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch join requests' });
  }
});

// Get user's join requests
router.get('/my-requests', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
            `SELECT jr.*, r.ride_uuid, r.start_time, r.fare, r.transport_mode, r.ride_provider, r.available_seats, r.gender_preference, r.preference_notes, r.creator_id,
              u.name as creator_name, u.username as creator_handle, u.user_id as creator_id,
              sl.name as start_name, sl.latitude as start_lat, sl.longitude as start_lng,
              dl.name as dest_name, dl.latitude as dest_lat, dl.longitude as dest_lng,
              rsl.name as ride_start_name, rsl.latitude as ride_start_lat, rsl.longitude as ride_start_lng,
              rdl.name as ride_dest_name, rdl.latitude as ride_dest_lat, rdl.longitude as ride_dest_lng,
              (SELECT status FROM Request_Status_Log WHERE request_id = jr.request_id ORDER BY timestamp DESC LIMIT 1) as current_status
             FROM Join_Request jr
             JOIN Ride r ON jr.ride_id = r.ride_id
             JOIN "User" u ON r.creator_id = u.user_id
             LEFT JOIN Location_Info sl ON jr.start_location_id = sl.location_id
             LEFT JOIN Location_Info dl ON jr.dest_location_id = dl.location_id
             LEFT JOIN Location_Info rsl ON r.start_location_id = rsl.location_id
             LEFT JOIN Location_Info rdl ON r.dest_location_id = rdl.location_id
             WHERE jr.partner_id = $1
             ORDER BY jr.timestamp DESC`,
      [req.userId]
    );

    res.json({ joinRequests: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch join requests' });
  }
});

// Check user's join request status for a specific ride
router.get('/status/:rideId', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT jr.request_id,
              (SELECT status FROM Request_Status_Log WHERE request_id = jr.request_id ORDER BY timestamp DESC LIMIT 1) as status
       FROM Join_Request jr
       WHERE jr.ride_id = $1 AND jr.partner_id = $2`,
      [req.params.rideId, req.userId]
    );

    if (result.rows.length === 0) {
      return res.json({ hasRequested: false, status: null });
    }

    res.json({ 
      hasRequested: true, 
      status: result.rows[0].status,
      requestId: result.rows[0].request_id
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to check join request status' });
  }
});

// Get a single join request by ID
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT jr.*, 
              li1.latitude as start_lat, li1.longitude as start_lng,
              li2.latitude as dest_lat, li2.longitude as dest_lng,
              (SELECT status FROM Request_Status_Log WHERE request_id = jr.request_id ORDER BY timestamp DESC LIMIT 1) as status
       FROM Join_Request jr
       LEFT JOIN Location_Info li1 ON jr.start_location_id = li1.location_id
       LEFT JOIN Location_Info li2 ON jr.dest_location_id = li2.location_id
       WHERE jr.request_id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Join request not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get join request' });
  }
});

// Accept a join request
router.patch('/:requestId/accept', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Get join request and verify creator ownership
    const requestResult = await client.query(
      `SELECT jr.*, r.creator_id, r.available_seats, r.fare, r.start_time
       FROM Join_Request jr
       JOIN Ride r ON jr.ride_id = r.ride_id
       WHERE jr.request_id = $1`,
      [req.params.requestId]
    );

    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Join request not found' });
    }

    const request = requestResult.rows[0];

    if (Number(request.creator_id) !== Number(req.userId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized' });
    }

    const requestStatus = await getCurrentRequestStatus(client, req.params.requestId);
    if (requestStatus !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only pending requests can be accepted' });
    }

    const rideJoinInfo = await getRideJoinInfo(client, request.ride_id);
    if (!rideJoinInfo) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ride not found' });
    }
    if (JOIN_BLOCKED_RIDE_STATUSES.has(rideJoinInfo.current_status) || hasRideReachedJoinCutoff(rideJoinInfo.start_time_utc || rideJoinInfo.start_time)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This ride is no longer accepting join requests' });
    }

    if (request.available_seats < 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No seats available' });
    }

    // Update request status
    await addRequestStatus(client, req.params.requestId, 'accepted');

    // AUDIT LOG: join request accepted
    await client.query(
      `INSERT INTO Audit_Log (action, actor_user_id, target_request_id, target_ride_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        'join_request_accepted',
        req.userId,
        req.params.requestId,
        request.ride_id,
        JSON.stringify({ partner_id: request.partner_id })
      ]
    );

    // Update available seats
    await client.query(
      'UPDATE Ride SET available_seats = available_seats - 1 WHERE ride_id = $1',
      [request.ride_id]
    );

    // Create notification for partner
    await client.query(
      `INSERT INTO Notification (user_id, type, message, related_ride_id, related_user_id, related_request_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        request.partner_id,
        'ride_update',
        'Your request to join the ride was accepted!',
        request.ride_id,
        req.userId,
        req.params.requestId
      ]
    );

    // Mark the original join_request notification as read
    await client.query(
      `UPDATE Notification SET is_read = true WHERE related_request_id = $1 AND type = 'join_request'`,
      [req.params.requestId]
    );

    // Add passenger to ride chat
    const chatResult = await client.query(
      'SELECT chat_id FROM Chat WHERE ride_id = $1 AND type = \'ride\'',
      [request.ride_id]
    );
    if (chatResult.rows.length > 0) {
      const chatId = chatResult.rows[0].chat_id;
      // Check if already in chat (though they shouldn't be)
      const participantCheck = await client.query(
        'SELECT * FROM Chat_Participants WHERE chat_id = $1 AND participant_id = $2',
        [chatId, request.partner_id]
      );
      if (participantCheck.rows.length === 0) {
        await client.query(
          'INSERT INTO Chat_Participants (chat_id, participant_id, role) VALUES ($1, $2, \'requester\')',
          [chatId, request.partner_id]
        );
      }
    }

    await client.query('COMMIT');

    res.json({ message: 'Join request accepted' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to accept join request' });
  } finally {
    client.release();
  }
});

// Reject a join request
router.patch('/:requestId/reject', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Verify creator ownership
    const requestResult = await client.query(
      `SELECT jr.*, r.creator_id FROM Join_Request jr
       JOIN Ride r ON jr.ride_id = r.ride_id
       WHERE jr.request_id = $1`,
      [req.params.requestId]
    );

    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Join request not found' });
    }

    if (Number(requestResult.rows[0].creator_id) !== Number(req.userId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized' });
    }

    const partnerId = requestResult.rows[0].partner_id;
    const rideId = requestResult.rows[0].ride_id;

    const requestStatus = await getCurrentRequestStatus(client, req.params.requestId);
    if (requestStatus !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only pending requests can be rejected' });
    }

    // Update status
    await addRequestStatus(client, req.params.requestId, 'rejected');

    // AUDIT LOG: join request rejected
    await client.query(
      `INSERT INTO Audit_Log (action, actor_user_id, target_request_id, target_ride_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        'join_request_rejected',
        req.userId,
        req.params.requestId,
        rideId,
        JSON.stringify({ partner_id: partnerId })
      ]
    );

    // Create notification
    await client.query(
      `INSERT INTO Notification (user_id, type, message, related_ride_id, related_user_id, related_request_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        partnerId,
        'ride_update',
        'Your request to join the ride was rejected',
        rideId,
        req.userId,
        req.params.requestId
      ]
    );

    // Mark the original join_request notification as read
    await client.query(
      `UPDATE Notification SET is_read = true WHERE related_request_id = $1 AND type = 'join_request'`,
      [req.params.requestId]
    );

    await client.query('COMMIT');

    res.json({ message: 'Join request rejected' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to reject join request' });
  } finally {
    client.release();
  }
});

// Cancel a join request (by partner)
router.patch('/:requestId/cancel', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify partner ownership
    const requestResult = await client.query(
      'SELECT partner_id, ride_id FROM Join_Request WHERE request_id = $1',
      [req.params.requestId]
    );

    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Join request not found' });
    }

    if (Number(requestResult.rows[0].partner_id) !== Number(req.userId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized' });
    }

    const rideJoinInfo = await getRideJoinInfo(client, requestResult.rows[0].ride_id);
    if (!rideJoinInfo) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ride not found' });
    }

    if (JOIN_BLOCKED_RIDE_STATUSES.has(rideJoinInfo.current_status) || hasRideReachedJoinCutoff(rideJoinInfo.start_time_utc || rideJoinInfo.start_time)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This ride is no longer accepting cancellation changes' });
    }

    const requestStatus = await getCurrentRequestStatus(client, req.params.requestId);
    if (requestStatus !== 'pending' && requestStatus !== 'accepted') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only active requests can be cancelled' });
    }

    // Update status
    await addRequestStatus(client, req.params.requestId, 'cancelled');

    // AUDIT LOG: join request cancelled
    await client.query(
      `INSERT INTO Audit_Log (action, actor_user_id, target_request_id, target_ride_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        'join_request_cancelled',
        req.userId,
        req.params.requestId,
        requestResult.rows[0].ride_id,
        NULL
      ]
    );

    if (requestStatus === 'accepted') {
      await client.query(
        'UPDATE Ride SET available_seats = available_seats + 1 WHERE ride_id = $1',
        [requestResult.rows[0].ride_id]
      );
    }

    await client.query('COMMIT');

    res.json({ message: 'Join request cancelled' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to cancel join request' });
  } finally {
    client.release();
  }
});

module.exports = router;
