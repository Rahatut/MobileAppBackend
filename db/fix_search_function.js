const pool = require('./pool');

const sql = `
DROP FUNCTION IF EXISTS public.get_available_rides_filtered(
    integer,
    double precision,
    double precision,
    double precision,
    double precision,
    double precision,
    transport_mode_enum,
    gender_enum,
    timestamp with time zone,
    timestamp with time zone,
    text
);

DROP FUNCTION IF EXISTS public.get_available_rides_filtered(
    integer,
    double precision,
    double precision,
    double precision,
    double precision,
    double precision,
    transport_mode_enum,
    gender_preference_enum,
    timestamp with time zone,
    timestamp with time zone,
    text
);

CREATE OR REPLACE FUNCTION public.get_available_rides_filtered(
    p_user_id integer DEFAULT NULL::integer, 
    p_start_lat double precision DEFAULT NULL::double precision, 
    p_start_lng double precision DEFAULT NULL::double precision, 
    p_end_lat double precision DEFAULT NULL::double precision, 
    p_end_lng double precision DEFAULT NULL::double precision, 
    p_radius_km double precision DEFAULT 5, 
    p_transport_mode transport_mode_enum DEFAULT NULL::transport_mode_enum, 
    p_gender_preference text DEFAULT NULL::text, 
    p_after_date timestamp with time zone DEFAULT NULL::timestamp with time zone, 
    p_before_date timestamp with time zone DEFAULT NULL::timestamp with time zone, 
    p_search_type text DEFAULT 'none'::text
)
 RETURNS TABLE(
    ride_id integer, 
    creator_id integer, 
    start_location_id integer, 
    dest_location_id integer, 
    status_log_id integer, 
    ride_uuid uuid, 
    route_polyline text, 
    created_at timestamp with time zone, 
    start_time timestamp with time zone, 
    gender_preference text, 
    preference_notes text, 
    transport_mode transport_mode_enum, 
    ride_provider ride_provider_enum, 
    fare numeric, 
    available_seats integer, 
    status text, 
    actual_fare numeric, 
    completion_time timestamp with time zone, 
    trip_duration_minutes integer, 
    updated_at timestamp with time zone, 
    creator_name text, 
    creator_username text, 
    creator_user_uuid uuid, 
    creator_avatar_url text, 
    creator_avg_rating numeric, 
    start_name text, 
    start_address text, 
    start_lat double precision, 
    start_lng double precision, 
    dest_name text, 
    dest_address text, 
    dest_lat double precision, 
    dest_lng double precision
)
 LANGUAGE plpgsql
AS $function$
DECLARE
    start_search_point geometry;
    end_search_point geometry;
    search_radius_meters double precision;
BEGIN
    -- Convert radius to meters
    search_radius_meters := p_radius_km * 1000;

    -- Create geometry points for search coordinates
    IF p_start_lat IS NOT NULL AND p_start_lng IS NOT NULL THEN
        start_search_point := ST_SetSRID(ST_MakePoint(p_start_lng, p_start_lat), 4326);
    END IF;

    IF p_end_lat IS NOT NULL AND p_end_lng IS NOT NULL THEN
        end_search_point := ST_SetSRID(ST_MakePoint(p_end_lng, p_end_lat), 4326);
    END IF;

    RETURN QUERY
    SELECT
        r.ride_id,
        r.creator_id,
        r.start_location_id,
        r.dest_location_id,
        r.status_log_id,
        r.ride_uuid,
        r.route_polyline,
        (r.created_at AT TIME ZONE 'UTC') AS created_at,
        (r.start_time AT TIME ZONE 'UTC') AS start_time,
        r.gender_preference::text,
        r.preference_notes::text,
        r.transport_mode,
        r.ride_provider,
        r.fare,
        r.available_seats,
        r.status::text,  
        r.actual_fare,
        (r.completion_time AT TIME ZONE 'UTC') AS completion_time,
        r.trip_duration_minutes,
        (r.updated_at AT TIME ZONE 'UTC') AS updated_at,

        u.name::text,
        u.username::text,
        u.user_uuid,
        u.avatar_url::text,
        u.avg_rating,

        ls.name::text,
        ls.address::text,
        ls.latitude::double precision,
        ls.longitude::double precision,

        ld.name::text,
        ld.address::text,
        ld.latitude::double precision,
        ld.longitude::double precision
    FROM Ride r
    JOIN \"User\" u ON u.user_id = r.creator_id
    JOIN Location_Info ls ON ls.location_id = r.start_location_id
    JOIN Location_Info ld ON ld.location_id = r.dest_location_id
    WHERE
        -- Exclude user's own rides
        (p_user_id IS NULL OR r.creator_id != p_user_id)
        
        -- Filter by ride status
        AND r.status = 'unactive'
        
        -- Location filtering
        AND (
            -- Case 1: No location filtering
            (p_search_type = 'none')
            
            OR
            
            -- Case 2: Search by start location only
            (p_search_type = 'start' 
             AND start_search_point IS NOT NULL 
             AND ST_DWithin(ls.geom::geography, start_search_point::geography, search_radius_meters))
            
            OR
            
            -- Case 3: Search by destination location only
            (p_search_type = 'destination' 
             AND end_search_point IS NOT NULL 
             AND ST_DWithin(ld.geom::geography, end_search_point::geography, search_radius_meters))
            
            OR
            
            -- Case 4: Search by both locations
            (p_search_type = 'both' 
             AND start_search_point IS NOT NULL 
             AND end_search_point IS NOT NULL
             AND (
                 -- SIMPLIFIED APPROACH: Use straight line matching
                 -- This avoids GeoJSON parsing errors entirely
                 
                 -- Option 1: Both points close to ride start/end
                 (ST_DWithin(ls.geom::geography, start_search_point::geography, search_radius_meters)
                  AND ST_DWithin(ld.geom::geography, end_search_point::geography, search_radius_meters))
                 
                 OR
                 
                 -- Option 2: Both points near the straight-line route with direction check
                 (ST_DWithin(
                      ST_MakeLine(ls.geom, ld.geom)::geography,
                      start_search_point::geography,
                      search_radius_meters
                  )
                  AND ST_DWithin(
                      ST_MakeLine(ls.geom, ld.geom)::geography,
                      end_search_point::geography,
                      search_radius_meters
                  )
                  -- Direction check: user start must come before user end
                  AND ST_LineLocatePoint(
                      ST_MakeLine(ls.geom, ld.geom),
                      ST_ClosestPoint(ST_MakeLine(ls.geom, ld.geom), start_search_point)
                  ) < ST_LineLocatePoint(
                      ST_MakeLine(ls.geom, ld.geom),
                      ST_ClosestPoint(ST_MakeLine(ls.geom, ld.geom), end_search_point)
                  ))
             ))
        )
        -- Additional filters
        AND (p_transport_mode IS NULL OR r.transport_mode = p_transport_mode)
        AND (p_gender_preference IS NULL OR r.gender_preference::text = p_gender_preference)
        AND (p_after_date IS NULL OR r.start_time >= p_after_date)
        AND (p_before_date IS NULL OR r.start_time <= p_before_date)
    ORDER BY r.start_time DESC;
END;
$function$;
`;

pool.query(sql)
  .then(() => {
    console.log('Successfully updated get_available_rides_filtered');
    process.exit(0);
  })
  .catch(err => {
    console.error('Error updating function:', err);
    process.exit(1);
  });
