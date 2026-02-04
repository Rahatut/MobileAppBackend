const express = require('express');
const pool = require('../db/pool');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// Helper function to add request status
async function addRequestStatus(client, requestId, status) {
  await client.query(
    'INSERT INTO Request_Status_Log (request_id, status) VALUES ($1, $2)',
    [requestId, status]
  );
}

// Helper function to get current request status
async function getCurrentRequestStatus(client, requestId) {
  const result = await client.query(
    `SELECT status FROM Request_Status_Log 
     WHERE request_id = $1 
     ORDER BY timestamp DESC LIMIT 1`,
    [requestId]
  );
  return result.rows.length > 0 ? result.rows[0].status : null;
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
    'INSERT INTO Location_Info (name, address, latitude, longitude) VALUES ($1, $2, $3, $4) RETURNING location_id',
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
      await client.query('ROLLBACK');
      const status = existingRequest.rows[0].status;
      if (status === 'accepted') {
        return res.status(400).json({ error: 'You have already joined this ride' });
      } else if (status === 'pending') {
        return res.status(400).json({ error: 'You have already requested to join this ride' });
      } else if (status === 'rejected') {
        return res.status(400).json({ error: 'Your previous request was declined' });
      }
    }

    // Check ride exists and has available seats
    const rideResult = await client.query(
      'SELECT available_seats, fare, creator_id FROM Ride WHERE ride_id = $1',
      [rideId]
    );

    if (rideResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ride not found' });
    }

    if (rideResult.rows[0].available_seats < 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No seats available' });
    }

    // Prevent creator from joining their own ride
    if (rideResult.rows[0].creator_id === req.userId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You cannot join your own ride' });
    }

    // Create locations if provided
    let startLocationId = null;
    let destLocationId = null;

    if (startLocation) {
      startLocationId = await getOrCreateLocation(
        client,
        startLocation.name || startLocation.address,
        startLocation.latitude,
        startLocation.longitude
      );
    }

    if (endLocation) {
      destLocationId = await getOrCreateLocation(
        client,
        endLocation.name || endLocation.address,
        endLocation.latitude,
        endLocation.longitude
      );
    }

    // Insert join request
    const result = await client.query(
      `INSERT INTO Join_Request (ride_id, partner_id, start_location_id, dest_location_id, route_polyline) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *`,
      [rideId, req.userId, startLocationId, destLocationId, routePolyline]
    );

    const joinRequest = result.rows[0];

    // Add initial status
    await addRequestStatus(client, joinRequest.request_id, 'pending');

    // Create notification for ride creator
    console.log('Creating notification for ride creator:', rideResult.rows[0].creator_id);
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
        rideResult.rows[0].creator_id,
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

    if (rideResult.rows[0].creator_id !== req.userId) {
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
      `SELECT jr.*, r.ride_uuid,
              sl.name as start_name, sl.latitude as start_lat, sl.longitude as start_lng,
              dl.name as dest_name, dl.latitude as dest_lat, dl.longitude as dest_lng,
              (SELECT status FROM Request_Status_Log WHERE request_id = jr.request_id ORDER BY timestamp DESC LIMIT 1) as current_status
       FROM Join_Request jr
       JOIN Ride r ON jr.ride_id = r.ride_id
       LEFT JOIN Location_Info sl ON jr.start_location_id = sl.location_id
       LEFT JOIN Location_Info dl ON jr.dest_location_id = dl.location_id
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

// Accept a join request
router.patch('/:requestId/accept', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Get join request and verify creator ownership
    const requestResult = await client.query(
      `SELECT jr.*, r.creator_id, r.available_seats, r.fare
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

    if (request.creator_id !== req.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (request.available_seats < 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No seats available' });
    }

    // Update request status
    await addRequestStatus(client, req.params.requestId, 'accepted');

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
        'join_request_accepted',
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

    if (requestResult.rows[0].creator_id !== req.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized' });
    }

    const partnerId = requestResult.rows[0].partner_id;
    const rideId = requestResult.rows[0].ride_id;

    // Update status
    await addRequestStatus(client, req.params.requestId, 'rejected');

    // Create notification
    await client.query(
      `INSERT INTO Notification (user_id, type, message, related_ride_id, related_user_id, related_request_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        partnerId,
        'join_request_rejected',
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
      'SELECT partner_id FROM Join_Request WHERE request_id = $1',
      [req.params.requestId]
    );

    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Join request not found' });
    }

    if (requestResult.rows[0].partner_id !== req.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Update status
    await addRequestStatus(client, req.params.requestId, 'cancelled');

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
