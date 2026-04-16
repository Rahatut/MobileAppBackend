const express = require('express');
// ...existing code...
const pool = require('../db/pool');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const FINAL_RIDE_STATUSES = new Set(['cancelled', 'completed', 'expired']);

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

async function getRideLifecycle(client, rideId) {
  const result = await client.query(
    `SELECT r.ride_id, r.creator_id, r.start_time,
            to_char(r.start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as start_time_utc,
            r.available_seats,
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

// Remove a passenger from a ride (creator only)
router.delete('/:rideId/passenger/:passengerId', authMiddleware, async (req, res) => {
  const { rideId, passengerId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Verify ride ownership
    const rideResult = await client.query(
      'SELECT creator_id FROM Ride WHERE ride_id = $1',
      [rideId]
    );
    if (rideResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ride not found' });
    }
    if (Number(rideResult.rows[0].creator_id) !== Number(req.userId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized to remove passenger' });
    }
    // Find join request for this passenger and ride
    const joinResult = await client.query(
      'SELECT request_id FROM Join_Request WHERE ride_id = $1 AND partner_id = $2',
      [rideId, passengerId]
    );
    if (joinResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Passenger not found in this ride' });
    }
    const requestId = joinResult.rows[0].request_id;

    const rideLifecycle = await getRideLifecycle(client, rideId);
    if (!rideLifecycle) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ride not found' });
    }
    if (rideLifecycle.current_status !== 'unactive' || hasRideReachedJoinCutoff(rideLifecycle.start_time_utc || rideLifecycle.start_time)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Passengers can only be removed before the ride starts' });
    }

    // Mark join request as removed
    await client.query(
      'INSERT INTO Request_Status_Log (request_id, status) VALUES ($1, $2)',
      [requestId, 'cancelled']
    );
    // Increment available_seats for the ride
    await client.query(
      'UPDATE Ride SET available_seats = available_seats + 1 WHERE ride_id = $1',
      [rideId]
    );
    await client.query('COMMIT');

    // Notify the removed passenger
    await client.query(
      `INSERT INTO Notification (user_id, type, message, related_ride_id, related_user_id)
       VALUES ($1, 'passenger_removed', 'You were removed from the ride', $2, $3)`,
      [passengerId, rideId, req.userId]
    );

    return res.json({ message: 'Passenger removed from ride, seat is now available' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Failed to remove passenger' });
  } finally {
    client.release();
  }
});

// ...existing code...

// Request to join a ride with custom pickup/dropoff
router.post('/:rideId/join', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    let { startLocation, destLocation } = req.body;
    const rideId = req.params.rideId;
    const partnerId = req.userId;

    await client.query('BEGIN');

    // Fetch original ride state and locations
    const rideDetailsResult = await client.query(
      `SELECT r.start_location_id, r.dest_location_id, r.creator_id, r.available_seats, r.start_time,
              COALESCE(
                (SELECT status FROM Ride_Status_Log WHERE ride_id = r.ride_id ORDER BY timestamp DESC LIMIT 1),
                'unactive'
              ) as current_status
       FROM Ride WHERE ride_id = $1`,
      [rideId]
    );

    if (rideDetailsResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ride not found' });
    }

    const originalRide = rideDetailsResult.rows[0];

    if (Number(originalRide.creator_id) === Number(partnerId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You cannot join your own ride' });
    }

    if (originalRide.current_status !== 'unactive') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This ride is no longer accepting join requests' });
    }

    if (hasRideReachedJoinCutoff(originalRide.start_time_utc || originalRide.start_time)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This ride has reached its join cutoff' });
    }

    if (originalRide.available_seats < 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No seats available' });
    }

    let finalStartLocationId;
    let finalDestLocationId;

    // Resolve start location
    if (startLocation && startLocation.latitude && startLocation.longitude) {
      finalStartLocationId = await getOrCreateLocation(
        client,
        startLocation.name || startLocation.address,
        startLocation.address,
        startLocation.latitude,
        startLocation.longitude
      );
    } else {
      finalStartLocationId = originalRide.start_location_id;
    }

    // Resolve destination location
    if (destLocation && destLocation.latitude && destLocation.longitude) {
      finalDestLocationId = await getOrCreateLocation(
        client,
        destLocation.name || destLocation.address,
        destLocation.address,
        destLocation.latitude,
        destLocation.longitude
      );
    } else {
      finalDestLocationId = originalRide.dest_location_id;
    }

    // Ensure we have valid location IDs before proceeding
    if (!finalStartLocationId || !finalDestLocationId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Could not determine valid start or destination location for join request.' });
    }

    // Create join request
    const joinResult = await client.query(
      `INSERT INTO Join_Request (ride_id, partner_id, start_location_id, dest_location_id, status_id)
       VALUES ($1, $2, $3, $4, NULL)
       RETURNING request_id`,
      [rideId, partnerId, finalStartLocationId, finalDestLocationId]
    );

    // Add initial status log
    await client.query(
      'INSERT INTO Request_Status_Log (request_id, status) VALUES ($1, $2)',
      [joinResult.rows[0].request_id, 'pending']
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Join request submitted' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to submit join request' });
  } finally {
    client.release();
  }
});

// Helper function to insert or get location
async function getOrCreateLocation(client, name, address, latitude, longitude) {
  const result = await client.query(
    'SELECT location_id FROM Location_Info WHERE latitude = $1 AND longitude = $2',
    [latitude, longitude]
  );

  if (result.rows.length > 0) {
    return result.rows[0].location_id;
  }

  const insertResult = await client.query(
    'INSERT INTO Location_Info (name, address, latitude, longitude, geom) VALUES ($1, $2, $3::numeric, $4::numeric, ST_SetSRID(ST_MakePoint($4::double precision, $3::double precision), 4326)) RETURNING location_id',
    [name, address, latitude, longitude]
  );

  return insertResult.rows[0].location_id;
}

// Helper function to add ride status and update the ride's status_log_id and status
async function addRideStatus(client, rideId, status) {
  const logResult = await client.query(
    'INSERT INTO Ride_Status_Log (ride_id, status) VALUES ($1, $2) RETURNING log_id',
    [rideId, status]
  );
  const logId = logResult.rows[0].log_id;
  await client.query(
    'UPDATE Ride SET status_log_id = $1, status = $2 WHERE ride_id = $3',
    [logId, status, rideId]
  );
  return logId;
}

// Helper function to get current ride status
async function getCurrentRideStatus(client, rideId) {
  const result = await client.query(
    `SELECT status FROM Ride_Status_Log 
     WHERE ride_id = $1 
     ORDER BY timestamp DESC LIMIT 1`,
    [rideId]
  );
  return result.rows.length > 0 ? result.rows[0].status : null;
}

// Create a ride
router.post('/', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const {
      startLocation,
      endLocation,
      startTime,
      transportMode,
      rideProvider,
      availableSeats,
      fare,
      genderPreference,
      notes,
      routePolyline,
    } = req.body;

    if (!startLocation || !endLocation || !startTime || !transportMode || !availableSeats || fare === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    await client.query('BEGIN');

    // Create or get locations
    const startLocationId = await getOrCreateLocation(
      client,
      startLocation.name || startLocation.address,
      startLocation.address,
      startLocation.latitude !== undefined ? startLocation.latitude : startLocation.lat,
      startLocation.longitude !== undefined ? startLocation.longitude : startLocation.lng
    );

    const destLocationId = await getOrCreateLocation(
      client,
      endLocation.name || endLocation.address,
      endLocation.address,
      endLocation.latitude !== undefined ? endLocation.latitude : endLocation.lat,
      endLocation.longitude !== undefined ? endLocation.longitude : endLocation.lng
    );

    // Create ride
    const rideResult = await client.query(
      `INSERT INTO Ride (creator_id, start_location_id, dest_location_id, start_time, 
                         transport_mode, ride_provider, available_seats, fare, 
                         gender_preference, preference_notes, route_polyline)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        req.userId,
        startLocationId,
        destLocationId,
        startTime,
        transportMode,
        rideProvider || 'Private',
        availableSeats,
        fare,
        genderPreference,
        notes,
        (() => {
          if (!routePolyline) return null;
          let parsed = typeof routePolyline === 'string' ? JSON.parse(routePolyline) : routePolyline;
          
          // Enforce GeoJSON LineString format exactly as converted by convert-polylines.js
          if (parsed && parsed.coordinates) {
             return JSON.stringify({
               type: 'LineString',
               coordinates: parsed.coordinates
             });
          }
          return JSON.stringify(parsed);
        })(),
      ]
    );

    const ride = rideResult.rows[0];

    // Add initial status
    await addRideStatus(client, ride.ride_id, 'unactive');

    // Create ride chat
    const chatResult = await client.query(
      `INSERT INTO Chat (ride_id, type, created_by) VALUES ($1, 'ride', $2) RETURNING chat_id`,
      [ride.ride_id, req.userId]
    );
    const chat = chatResult.rows[0];

    // Add creator to chat
    await client.query(
      `INSERT INTO Chat_Participants (chat_id, participant_id, role) VALUES ($1, $2, 'creator')`,
      [chat.chat_id, req.userId]
    );

    const fullRideResult = await client.query(
      `SELECT r.*, 
              to_char(r.start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as start_time,
              u.name, u.username, u.user_uuid, u.avatar_url, u.avg_rating,
              sl.name as start_name, sl.address as start_address, sl.latitude as start_lat, sl.longitude as start_lng,
              dl.name as dest_name, dl.address as dest_address, dl.latitude as dest_lat, dl.longitude as dest_lng,
              (SELECT status FROM Ride_Status_Log WHERE ride_id = r.ride_id ORDER BY timestamp DESC LIMIT 1) as current_status
       FROM Ride r
       JOIN "User" u ON r.creator_id = u.user_id
       LEFT JOIN Location_Info sl ON r.start_location_id = sl.location_id
       LEFT JOIN Location_Info dl ON r.dest_location_id = dl.location_id
       WHERE r.ride_id = $1`,
      [ride.ride_id]
    );

    await client.query('COMMIT');

    res.status(201).json({ message: 'Ride created', ride: fullRideResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to create ride' });
  } finally {
    client.release();
  }
});

// Get all active rides (with optional filters)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const {
      transportMode,
      genderPreference,
      afterDate,
      beforeDate,
      startLocationLat,
      startLocationLng,
      endLocationLat,
      endLocationLng,
      radiusKm = 5
    } = req.query;

    // Determine search type based on which coordinates are provided
    let searchType = 'none';
    
    const hasStart = startLocationLat && startLocationLng;
    const hasEnd = endLocationLat && endLocationLng;
    
    if (hasStart && hasEnd) {
      searchType = 'both';
    } else if (hasStart) {
      searchType = 'start';
    } else if (hasEnd) {
      searchType = 'destination';
    }

    const result = await pool.query(
      `SELECT * FROM get_available_rides_filtered(
        $1::integer, 
        $2::double precision, $3::double precision,
        $4::double precision, $5::double precision,
        $6::double precision,
        $7::transport_mode_enum, $8::text,
        $9::timestamp with time zone, $10::timestamp with time zone,
        $11::text
      )`,
      [
        req.userId, 
        startLocationLat ? parseFloat(startLocationLat) : null,
        startLocationLng ? parseFloat(startLocationLng) : null,
        endLocationLat ? parseFloat(endLocationLat) : null,
        endLocationLng ? parseFloat(endLocationLng) : null,
        parseFloat(radiusKm),
        transportMode || null,
        genderPreference ? genderPreference.toLowerCase() : null,
        afterDate ? new Date(afterDate).toISOString() : null,
        beforeDate ? new Date(beforeDate).toISOString() : null,
        searchType
      ]
    );

    res.json({
      rides: result.rows,
      total: result.rows.length,
      searchType, // Include this so frontend knows what search was performed
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch rides' });
  }
});


// Get user's rides (as creator)
router.get('/driver/my-rides', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, 
              to_char(r.start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as start_time,
              u.name, u.username, u.user_uuid, u.avatar_url, u.avg_rating,
              sl.name as start_name, sl.address as start_address, sl.latitude as start_lat, sl.longitude as start_lng,
              dl.name as dest_name, dl.address as dest_address, dl.latitude as dest_lat, dl.longitude as dest_lng,
              (SELECT status FROM Ride_Status_Log WHERE ride_id = r.ride_id ORDER BY timestamp DESC LIMIT 1) as current_status
       FROM Ride r
       JOIN "User" u ON r.creator_id = u.user_id
       LEFT JOIN Location_Info sl ON r.start_location_id = sl.location_id
       LEFT JOIN Location_Info dl ON r.dest_location_id = dl.location_id
       WHERE r.creator_id = $1 
       ORDER BY r.start_time DESC`,
      [req.userId]
    );

    res.json({ rides: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch rides' });
  }
});

// Get rides user has joined (as passenger)
router.get('/passenger/my-rides', authMiddleware, async (req, res) => {
  try {
    console.log('🔵 Fetching joined rides for user:', req.userId);
    const result = await pool.query(
      `SELECT r.*, 
              to_char(r.start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as start_time,
              u.name, u.username, u.user_uuid, u.avatar_url, u.avg_rating,
              sl.name as start_name, sl.address as start_address, sl.latitude as start_lat, sl.longitude as start_lng,
              dl.name as dest_name, dl.address as dest_address, dl.latitude as dest_lat, dl.longitude as dest_lng,
              (SELECT status FROM Ride_Status_Log WHERE ride_id = r.ride_id ORDER BY timestamp DESC LIMIT 1) as current_status,
              (SELECT status FROM Request_Status_Log WHERE request_id = jr.request_id ORDER BY timestamp DESC LIMIT 1) as join_status
       FROM Join_Request jr
       JOIN Ride r ON jr.ride_id = r.ride_id
       JOIN "User" u ON r.creator_id = u.user_id
       LEFT JOIN Location_Info sl ON r.start_location_id = sl.location_id
       LEFT JOIN Location_Info dl ON r.dest_location_id = dl.location_id
       WHERE jr.partner_id = $1 
       AND (SELECT status FROM Request_Status_Log WHERE request_id = jr.request_id ORDER BY timestamp DESC LIMIT 1) = 'accepted'
       ORDER BY r.start_time DESC`,
      [req.userId]
    );
    console.log('✅ Found', result.rows.length, 'joined rides');

    res.json({ rides: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch joined rides' });
  }
});

// Get ride by ID or UUID
router.get('/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const isUuid = identifier.includes('-');
    
    const query = `
      SELECT r.*, 
             to_char(r.start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as start_time,
             u.name, u.username, u.user_uuid, u.avatar_url, u.avg_rating,
             sl.name as start_name, sl.address as start_address, sl.latitude as start_lat, sl.longitude as start_lng,
             dl.name as dest_name, dl.address as dest_address, dl.latitude as dest_lat, dl.longitude as dest_lng,
             (SELECT status FROM Ride_Status_Log WHERE ride_id = r.ride_id ORDER BY timestamp DESC LIMIT 1) as current_status
      FROM Ride r
      JOIN "User" u ON r.creator_id = u.user_id
      LEFT JOIN Location_Info sl ON r.start_location_id = sl.location_id
      LEFT JOIN Location_Info dl ON r.dest_location_id = dl.location_id
      WHERE ${isUuid ? 'r.ride_uuid' : 'r.ride_id'} = $1
    `;

    const result = await pool.query(query, [identifier]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    // Get passengers/partners for this ride, including pickup/dropoff coordinates and route polyline
    const passengersResult = await pool.query(
      `SELECT u.user_id, u.user_uuid, u.name, u.username, u.avatar_url, u.avg_rating,
              jr.request_id,
              (SELECT status FROM Request_Status_Log WHERE request_id = jr.request_id ORDER BY timestamp DESC LIMIT 1) as status,
              sl.name as start_name, sl.address as start_address, sl.latitude as start_lat, sl.longitude as start_lng,
              dl.name as dest_name, dl.address as dest_address, dl.latitude as dest_lat, dl.longitude as dest_lng,
              jr.route_polyline
       FROM Join_Request jr
       JOIN "User" u ON jr.partner_id = u.user_id
       LEFT JOIN Location_Info sl ON jr.start_location_id = sl.location_id
       LEFT JOIN Location_Info dl ON jr.dest_location_id = dl.location_id
       WHERE jr.ride_id = $1 
       AND (SELECT status FROM Request_Status_Log WHERE request_id = jr.request_id ORDER BY timestamp DESC LIMIT 1) = 'accepted'`,
      [result.rows[0].ride_id]
    );

    // Add totalPassengers to response
    const totalPassengers = result.rows[0].total_passengers || result.rows[0].totalPassengers || result.rows[0].available_seats || 0;
    res.json({
      ride: {
        ...result.rows[0],
        totalPassengers,
      },
      passengers: passengersResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch ride' });
  }
});

// Edit ride details (creator only)
router.put('/:rideId', authMiddleware, async (req, res) => {
  const { rideId } = req.params;
  const { fare, transportMode, rideProvider, genderPreference, availableSeats, notes } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verify ownership
    const rideResult = await client.query(
      'SELECT creator_id FROM Ride WHERE ride_id = $1',
      [rideId]
    );

    if (rideResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ride not found' });
    }

    if (Number(rideResult.rows[0].creator_id) !== Number(req.userId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized to edit this ride' });
    }

    const updateResult = await client.query(
      `UPDATE Ride
       SET fare               = COALESCE($1, fare),
           transport_mode     = COALESCE($2, transport_mode),
           ride_provider      = COALESCE($3, ride_provider),
           gender_preference  = COALESCE($4, gender_preference),
           available_seats    = COALESCE($5, available_seats),
           preference_notes   = COALESCE($6, preference_notes),
           updated_at         = CURRENT_TIMESTAMP
       WHERE ride_id = $7
       RETURNING *`,
      [
        fare !== undefined ? parseFloat(fare) : null,
        transportMode || null,
        rideProvider || null,
        genderPreference || null,
        availableSeats !== undefined ? parseInt(availableSeats) : null,
        notes !== undefined ? notes : null,
        rideId,
      ]
    );

    await client.query('COMMIT');

    // Notify all accepted passengers
    const passengersResult = await client.query(
      `SELECT partner_id FROM Join_Request jr
       WHERE ride_id = $1 
       AND (SELECT status FROM Request_Status_Log WHERE request_id = jr.request_id ORDER BY timestamp DESC LIMIT 1) = 'accepted'`,
      [rideId]
    );
    for (const passenger of passengersResult.rows) {
      await client.query(
        `INSERT INTO Notification (user_id, type, message, related_ride_id, related_user_id)
         VALUES ($1, 'ride_edited', 'The ride details have been updated', $2, $3)`,
        [passenger.partner_id, rideId, req.userId]
      );
    }

    return res.json({ message: 'Ride updated', ride: updateResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Failed to update ride' });
  } finally {
    client.release();
  }
});

// Update ride status
router.patch('/:rideId/status', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { status } = req.body;

    if (!['unactive', 'started', 'cancelled', 'completed', 'expired'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    await client.query('BEGIN');

    // Verify ownership
    const rideLifecycle = await getRideLifecycle(client, req.params.rideId);

    if (!rideLifecycle) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ride not found' });
    }

    if (Number(rideLifecycle.creator_id) !== Number(req.userId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized' });
    }

    const currentStatus = rideLifecycle.current_status || 'unactive';
    if (currentStatus === status) {
      await client.query('ROLLBACK');
      return res.json({ message: 'Ride status already set', status });
    }

    const allowedTransitions = {
      unactive: new Set(['started', 'cancelled', 'expired', 'completed']),
      started: new Set(['completed', 'cancelled', 'expired']),
      cancelled: new Set([]),
      completed: new Set([]),
      expired: new Set([]),
    };

    if (!allowedTransitions[currentStatus] || !allowedTransitions[currentStatus].has(status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot change ride status from ${currentStatus} to ${status}` });
    }

    if (status === 'started' && toDateSafe(rideLifecycle.start_time_utc || rideLifecycle.start_time) > new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Ride cannot be started before its scheduled start time' });
    }

    // Add status log
    await addRideStatus(client, req.params.rideId, status);

    await client.query('COMMIT');

    if (status === 'cancelled') {
        const passengersResult = await client.query(
          `SELECT partner_id FROM Join_Request jr
           WHERE ride_id = $1 
           AND (SELECT status FROM Request_Status_Log WHERE request_id = jr.request_id ORDER BY timestamp DESC LIMIT 1) = 'accepted'`,
          [req.params.rideId]
        );
        for (const passenger of passengersResult.rows) {
          await client.query(
            `INSERT INTO Notification (user_id, type, message, related_ride_id, related_user_id)
             VALUES ($1, 'ride_cancelled', 'The ride has been cancelled by the creator', $2, $3)`,
            [passenger.partner_id, req.params.rideId, req.userId]
          );
        }
    } else {
        // General status update (started, etc.)
        const passengersResult = await client.query(
          `SELECT partner_id FROM Join_Request jr
           WHERE ride_id = $1 
           AND (SELECT status FROM Request_Status_Log WHERE request_id = jr.request_id ORDER BY timestamp DESC LIMIT 1) = 'accepted'`,
          [req.params.rideId]
        );
        for (const passenger of passengersResult.rows) {
          await client.query(
            `INSERT INTO Notification (user_id, type, message, related_ride_id, related_user_id)
             VALUES ($1, 'ride_update', $2, $3, $4)`,
            [passenger.partner_id, 'ride_update', `Ride status updated to ${status}`, req.params.rideId, req.userId]
          );
        }
    }

    res.json({ message: 'Ride status updated', status });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to update ride' });
  } finally {
    client.release();
  }
});

// Complete a ride with fare finalization
router.post('/:rideId/complete', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { actualFare, endLocation, completionTime } = req.body;
    const rideId = req.params.rideId;

    if (!actualFare) {
      return res.status(400).json({ error: 'Actual fare is required' });
    }

    await client.query('BEGIN');

    // Verify ownership
    const rideLifecycle = await getRideLifecycle(client, rideId);

    if (!rideLifecycle) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ride not found' });
    }

    if (Number(rideLifecycle.creator_id) !== Number(req.userId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized' });
    }

    const currentStatus = rideLifecycle.current_status || 'unactive';
    const completionMoment = completionTime || new Date();
    const startedAt = toDateSafe(rideLifecycle.start_time_utc || rideLifecycle.start_time);

    if (!startedAt) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Ride has invalid start time data' });
    }

    if (FINAL_RIDE_STATUSES.has(currentStatus)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Ride is already closed' });
    }

    if (currentStatus === 'unactive' && startedAt > new Date(completionMoment)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Ride cannot be completed before it starts' });
    }

    if (currentStatus === 'unactive' && startedAt <= new Date(completionMoment)) {
      await addRideStatus(client, rideId, 'started');
    }

    const tripDuration = new Date(completionMoment) - startedAt;
    const tripDurationMinutes = Math.round(tripDuration / 60000);

    // Update ride with completion details
    const updateResult = await client.query(
      `UPDATE Ride 
       SET actual_fare = $1,
           completion_time = $2,
           trip_duration_minutes = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE ride_id = $4
       RETURNING *`,
      [actualFare, completionMoment, tripDurationMinutes, rideId]
    );

    // Add completion status log
    await addRideStatus(client, rideId, 'completed');

    // Update creator total rides
    await client.query(
      'UPDATE "User" SET total_rides = total_rides + 1 WHERE user_id = $1',
      [req.userId]
    );

    // Get all passengers who joined this ride and their join requests
    const passengersResult = await client.query(
      `SELECT DISTINCT jr.partner_id FROM Join_Request jr
       WHERE jr.ride_id = $1 
       AND (SELECT status FROM Request_Status_Log WHERE request_id = jr.request_id ORDER BY timestamp DESC LIMIT 1) = 'accepted'`,
      [rideId]
    );

    // Update total_rides for all passengers who completed the ride
    for (const passenger of passengersResult.rows) {
      await client.query(
        'UPDATE "User" SET total_rides = total_rides + 1 WHERE user_id = $1',
        [passenger.partner_id]
      );

      // Create completion notification for passenger
      await client.query(
        `INSERT INTO Notification (user_id, type, message, related_ride_id, related_user_id, is_read, action, ride_info)
         VALUES ($1, 'ride_update', $2, $3, $4, false, $5, $6)`,
        [
          passenger.partner_id,
          'Your ride has been completed. Please rate your fellow passengers.',
          rideId,
          req.userId,
          JSON.stringify({ type: 'open_buddy_feedback', rideId }),
          JSON.stringify({
            rideId,
            fare: actualFare,
            startTime: ride.start_time,
            completionTime: completionTime || new Date(),
            creatorId: ride.creator_id,
            // Add more ride info as needed
          })
        ]
      );
    }

    // Create completion notification for driver
    if (passengersResult.rows.length > 0) {
      await client.query(
        `INSERT INTO Notification (user_id, type, message, related_ride_id, is_read)
         VALUES ($1, 'ride_completed', 'Your ride has been completed with ' || $2 || ' passenger(s)', $3, false)`,
        [req.userId, passengersResult.rows.length, rideId]
      );
    }

    await client.query('COMMIT');

    res.json({
      message: 'Ride completed successfully',
      ride: updateResult.rows[0],
      tripDurationMinutes,
      passengersCompleted: passengersResult.rows.length,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to complete ride' });
  } finally {
    client.release();
  }
});

// Calculate fare based on distance/duration
router.post('/:rideId/calculate-fare', async (req, res) => {
  try {
    const { distance, duration, baseFare = 50, perKmRate = 10, perMinuteRate = 2 } = req.body;

    if (!distance || !duration) {
      return res.status(400).json({ error: 'Distance and duration are required' });
    }

    const distanceFare = distance * perKmRate;
    const durationFare = duration * perMinuteRate;
    const totalFare = Math.max(baseFare, distanceFare + durationFare);

    res.json({
      baseFare,
      distanceKm: distance,
      durationMinutes: duration,
      distanceFare: parseFloat(distanceFare.toFixed(2)),
      durationFare: parseFloat(durationFare.toFixed(2)),
      totalFare: parseFloat(totalFare.toFixed(2)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to calculate fare' });
  }
});

// Delete a past ride (creator only)
router.delete('/:rideId', authMiddleware, async (req, res) => {
  const { rideId } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const isNumericId = /^\d+$/.test(String(rideId));
    const rideResult = await client.query(
      `SELECT r.ride_id, r.creator_id,
              (SELECT status FROM Ride_Status_Log WHERE ride_id = r.ride_id ORDER BY timestamp DESC LIMIT 1) as current_status
       FROM Ride r
       WHERE ${isNumericId ? 'r.ride_id = $1' : 'r.ride_uuid = $1'}`,
      [rideId]
    );

    if (rideResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ride not found' });
    }

    const ride = rideResult.rows[0];
    if (Number(ride.creator_id) !== Number(req.userId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized to delete this ride' });
    }

    if (!['completed', 'cancelled', 'expired'].includes(ride.current_status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only past rides can be deleted' });
    }

    await client.query('DELETE FROM Ride WHERE ride_id = $1', [ride.ride_id]);

    await client.query('COMMIT');
    return res.json({ message: 'Ride deleted' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete ride' });
  } finally {
    client.release();
  }
});

module.exports = router;
