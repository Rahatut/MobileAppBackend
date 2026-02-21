const pool = require('../db/pool');

async function run() {
    try {
        console.log('Fixing NULL geoms...');
        const res = await pool.query(`
            UPDATE Location_Info
            SET geom = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)
            WHERE geom IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL;
        `);
        console.log(`Updated ${res.rowCount} rows.`);
    } catch (e) {
        console.error(e);
    } finally {
        process.exit();
    }
}

run();
