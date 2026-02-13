
const express = require('express');
const pool = require('../db/pool');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// Request to join a ride with custom pickup/dropoff
router.post('/:rideId/join', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { startLocation, destLocation } = req.body;
    const rideId = req.params.rideId;
    const partnerId = req.userId;

    if (!startLocation || !destLocation) {
      return res.status(400).json({ error: 'Missing pickup/dropoff location' });
    }

    await client.query('BEGIN');

    // Insert or get pickup location
    const startLocationId = await getOrCreateLocation(
      client,
      startLocation.name || startLocation.address,
      startLocation.address,
      startLocation.latitude,
      startLocation.longitude
    );

    // Insert or get dropoff location
    const destLocationId = await getOrCreateLocation(
      client,
      destLocation.name || destLocation.address,
      destLocation.address,
      destLocation.latitude,
      destLocation.longitude
    );

    // Create join request
    const joinResult = await client.query(
      `INSERT INTO Join_Request (ride_id, partner_id, start_location_id, dest_location_id, status_id)
       VALUES ($1, $2, $3, $4, NULL)
       RETURNING request_id`,
      [rideId, partnerId, startLocationId, destLocationId]
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
    'INSERT INTO Location_Info (name, address, latitude, longitude) VALUES ($1, $2, $3, $4) RETURNING location_id',
    [name, address, latitude, longitude]
  );

  return insertResult.rows[0].location_id;
}

// Helper function to add ride status
async function addRideStatus(client, rideId, status) {
  await client.query(
    'INSERT INTO Ride_Status_Log (ride_id, status) VALUES ($1, $2)',
    [rideId, status]
  );
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
      startLocation.latitude,
      startLocation.longitude
    );

    const destLocationId = await getOrCreateLocation(
      client,
      endLocation.name || endLocation.address,
      endLocation.address,
      endLocation.latitude,
      endLocation.longitude
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
        routePolyline,
      ]
    );

    const ride = rideResult.rows[0];

    // Add initial status
    await addRideStatus(client, ride.ride_id, 'unactive');

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
      radiusKm = 5,
      page = 1,
      limit = 10
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
        $1::double precision, $2::double precision,
        $3::double precision, $4::double precision,
        $5::double precision,
        $6::transport_mode_enum, $7::gender_enum,
        $8::timestamp with time zone, $9::timestamp with time zone,
        $10::text
      )`,
      [
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

    // Apply pagination
    const paginatedRides = result.rows.slice((page - 1) * limit, page * limit);
    const totalCount = result.rows.length;

    res.json({
      rides: paginatedRides,
      total: totalCount,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(totalCount / limit),
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

    // Get passengers/partners for this ride, including pickup/dropoff coordinates
    const passengersResult = await pool.query(
      `SELECT u.user_id, u.user_uuid, u.name, u.username, u.avatar_url, u.avg_rating,
              (SELECT status FROM Request_Status_Log WHERE request_id = jr.request_id ORDER BY timestamp DESC LIMIT 1) as status,
              sl.name as start_name, sl.address as start_address, sl.latitude as start_lat, sl.longitude as start_lng,
              dl.name as dest_name, dl.address as dest_address, dl.latitude as dest_lat, dl.longitude as dest_lng
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
    const rideResult = await client.query('SELECT creator_id FROM Ride WHERE ride_id = $1', [req.params.rideId]);

    if (rideResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ride not found' });
    }

    if (rideResult.rows[0].creator_id !== req.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Add status log
    await addRideStatus(client, req.params.rideId, status);

    await client.query('COMMIT');

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
    const rideResult = await client.query(
      'SELECT creator_id, fare, start_time FROM Ride WHERE ride_id = $1',
      [rideId]
    );

    if (rideResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ride not found' });
    }

    if (rideResult.rows[0].creator_id !== req.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Not authorized' });
    }

    const ride = rideResult.rows[0];
    const tripDuration = new Date(completionTime || new Date()) - new Date(ride.start_time);
    const tripDurationMinutes = Math.round(tripDuration / 60000);

    // Update ride with completion details
    const updateResult = await client.query(
      `UPDATE Ride 
       SET status = 'completed',
           actual_fare = $1,
           completion_time = $2,
           trip_duration_minutes = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE ride_id = $4
       RETURNING *`,
      [actualFare, completionTime || new Date(), tripDurationMinutes, rideId]
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
        `INSERT INTO Notification (user_id, type, message, related_ride_id, related_user_id, is_read)
         VALUES ($1, 'ride_completed', 'Your ride has been completed', $2, $3, false)`,
        [passenger.partner_id, rideId, req.userId]
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
