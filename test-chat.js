require('dotenv').config();
const pool = require('./db/pool');
async function test() {
  try {
    const result = await pool.query(
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
           END as membership_status
         FROM Ride r
         LEFT JOIN Join_Request jr ON jr.ride_id = r.ride_id AND jr.partner_id = $2
         WHERE r.ride_id = $1`,
        [204, 9] // 204 is ride_id, 9 is user_id
      );
      console.log(result.rows);
  } catch (e) { console.error(e); }
  process.exit();
}
test();
