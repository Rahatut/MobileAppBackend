const polyline = require('@mapbox/polyline');
const pool = require('../db/pool');

async function decodeAndConvert() {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT ride_id, route_polyline
      FROM Ride
      WHERE route_polyline IS NOT NULL 
      AND route_polyline !~ '^\{'
    `);

    for (const ride of result.rows) {
      try {
        // Decode polyline to coordinates
        const coords = polyline.decode(ride.route_polyline);
        
        // Convert to GeoJSON
        const geojson = {
          type: 'LineString',
          coordinates: coords.map(([lat, lng]) => [lng, lat])  // Note: GeoJSON is [lng, lat]
        };

        // Update database
        await client.query(
          'UPDATE Ride SET route_polyline = $1 WHERE ride_id = $2',
          [JSON.stringify(geojson), ride.ride_id]
        );

        console.log(`✓ Decoded ride ${ride.ride_id}`);
      } catch (error) {
        console.error(`✗ Failed ride ${ride.ride_id}:`, error.message);
      }
    }
  } finally {
    client.release();
    console.log('Finished converting polylines.');
  }
}

decodeAndConvert();
