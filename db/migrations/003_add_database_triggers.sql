-- Migration: Add Database Triggers for Auto-Update Fields
-- Date: 2026-02-03
-- Description: Implement triggers for automatic field updates

-- ============================
-- RATING TRIGGERS
-- ============================

-- Update user's average rating when a new rating is inserted
CREATE OR REPLACE FUNCTION update_user_avg_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE "User"
  SET avg_rating = (
    SELECT COALESCE(ROUND(AVG(rating)::numeric, 2), 0)
    FROM Rating
    WHERE ratee_id = NEW.ratee_id
  )
  WHERE user_id = NEW.ratee_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_user_avg_rating_on_insert ON Rating;

CREATE TRIGGER trigger_update_user_avg_rating_on_insert
AFTER INSERT ON Rating
FOR EACH ROW
EXECUTE FUNCTION update_user_avg_rating();

-- Update user's average rating when a rating is updated
DROP TRIGGER IF EXISTS trigger_update_user_avg_rating_on_update ON Rating;

CREATE TRIGGER trigger_update_user_avg_rating_on_update
AFTER UPDATE ON Rating
FOR EACH ROW
EXECUTE FUNCTION update_user_avg_rating();

-- Update user's average rating when a rating is deleted
CREATE OR REPLACE FUNCTION update_user_avg_rating_on_delete()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE "User"
  SET avg_rating = (
    SELECT COALESCE(ROUND(AVG(rating)::numeric, 2), 0)
    FROM Rating
    WHERE ratee_id = OLD.ratee_id
  )
  WHERE user_id = OLD.ratee_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_user_avg_rating_on_delete ON Rating;

CREATE TRIGGER trigger_update_user_avg_rating_on_delete
AFTER DELETE ON Rating
FOR EACH ROW
EXECUTE FUNCTION update_user_avg_rating_on_delete();

-- ============================
-- RIDE COMPLETION TRIGGERS
-- ============================

-- Update total_rides for driver when ride is completed
CREATE OR REPLACE FUNCTION update_driver_total_rides()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status != 'completed' THEN
    UPDATE "User"
    SET total_rides = total_rides + 1
    WHERE user_id = NEW.creator_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_driver_total_rides ON Ride;

CREATE TRIGGER trigger_update_driver_total_rides
AFTER UPDATE ON Ride
FOR EACH ROW
EXECUTE FUNCTION update_driver_total_rides();

-- Update total_rides for passengers when ride is completed
CREATE OR REPLACE FUNCTION update_passenger_total_rides()
RETURNS TRIGGER AS $$
DECLARE
  ride_status VARCHAR(50);
BEGIN
  -- Get the current status of the ride
  SELECT status INTO ride_status FROM Ride WHERE ride_id = NEW.ride_id LIMIT 1;
  
  IF ride_status = 'completed' THEN
    UPDATE "User"
    SET total_rides = total_rides + 1
    WHERE user_id = NEW.partner_id
    AND (
      SELECT status FROM Request_Status_Log 
      WHERE request_id = NEW.request_id 
      ORDER BY timestamp DESC LIMIT 1
    ) = 'accepted';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_passenger_total_rides ON Join_Request;

CREATE TRIGGER trigger_update_passenger_total_rides
AFTER INSERT ON Join_Request
FOR EACH ROW
EXECUTE FUNCTION update_passenger_total_rides();

-- ============================
-- RIDE STATUS LOGGING
-- ============================

-- Automatically log ride status changes
CREATE OR REPLACE FUNCTION log_ride_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO Ride_Status_Log (ride_id, status, timestamp)
    VALUES (NEW.ride_id, NEW.status, CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Note: This assumes Ride table has a status column
-- If using only Ride_Status_Log for history, comment this out
-- DROP TRIGGER IF EXISTS trigger_log_ride_status_change ON Ride;
-- CREATE TRIGGER trigger_log_ride_status_change
-- AFTER UPDATE ON Ride
-- FOR EACH ROW
-- EXECUTE FUNCTION log_ride_status_change();

-- ============================
-- REQUEST STATUS LOGGING
-- ============================

-- Automatically log join request status changes
CREATE OR REPLACE FUNCTION log_request_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO Request_Status_Log (request_id, status, timestamp)
    VALUES (NEW.request_id, NEW.status, CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Note: This assumes Join_Request table has a status column
-- If using only Request_Status_Log for history, comment this out

-- ============================
-- NOTIFICATION AUTO-CLEANUP
-- ============================

-- Delete read notifications older than 30 days (optional)
CREATE OR REPLACE FUNCTION cleanup_old_notifications()
RETURNS void AS $$
BEGIN
  DELETE FROM Notification
  WHERE is_read = true
  AND created_at < CURRENT_TIMESTAMP - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;

-- Schedule the cleanup (if using pg_cron extension)
-- SELECT cron.schedule('cleanup-old-notifications', '0 2 * * *', 'SELECT cleanup_old_notifications()');

-- ============================
-- TIMESTAMP UPDATES
-- ============================

-- Auto-update 'updated_at' for User table
CREATE OR REPLACE FUNCTION update_user_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_user_timestamp ON "User";

CREATE TRIGGER trigger_update_user_timestamp
BEFORE UPDATE ON "User"
FOR EACH ROW
EXECUTE FUNCTION update_user_timestamp();

-- Auto-update 'updated_at' for Chat
CREATE OR REPLACE FUNCTION update_chat_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_chat_timestamp ON Chat;

CREATE TRIGGER trigger_update_chat_timestamp
BEFORE UPDATE ON Chat
FOR EACH ROW
EXECUTE FUNCTION update_chat_timestamp();

-- Auto-update 'updated_at' for Message
CREATE OR REPLACE FUNCTION update_message_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_message_timestamp ON Message;

CREATE TRIGGER trigger_update_message_timestamp
BEFORE UPDATE ON Message
FOR EACH ROW
EXECUTE FUNCTION update_message_timestamp();

-- Auto-update 'updated_at' for Ride
CREATE OR REPLACE FUNCTION update_ride_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_ride_timestamp ON Ride;

CREATE TRIGGER trigger_update_ride_timestamp
BEFORE UPDATE ON Ride
FOR EACH ROW
EXECUTE FUNCTION update_ride_timestamp();

-- ============================
-- VALIDATION TRIGGERS
-- ============================

-- Prevent rating a user for a ride they weren't part of
CREATE OR REPLACE FUNCTION validate_rating_participation()
RETURNS TRIGGER AS $$
DECLARE
  rater_in_ride BOOLEAN;
  ratee_in_ride BOOLEAN;
BEGIN
  -- Check if rater was part of the ride
  SELECT EXISTS(
    SELECT 1 FROM Ride WHERE ride_id = NEW.ride_id AND creator_id = NEW.rater_id
    UNION
    SELECT 1 FROM Join_Request WHERE ride_id = NEW.ride_id AND partner_id = NEW.rater_id
  ) INTO rater_in_ride;

  -- Check if ratee was part of the ride
  SELECT EXISTS(
    SELECT 1 FROM Ride WHERE ride_id = NEW.ride_id AND creator_id = NEW.ratee_id
    UNION
    SELECT 1 FROM Join_Request WHERE ride_id = NEW.ride_id AND partner_id = NEW.ratee_id
  ) INTO ratee_in_ride;

  IF NOT (rater_in_ride AND ratee_in_ride) THEN
    RAISE EXCEPTION 'Both users must have been part of this ride to rate each other';
  END IF;

  IF NEW.rater_id = NEW.ratee_id THEN
    RAISE EXCEPTION 'Users cannot rate themselves';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_validate_rating_participation ON Rating;

CREATE TRIGGER trigger_validate_rating_participation
BEFORE INSERT ON Rating
FOR EACH ROW
EXECUTE FUNCTION validate_rating_participation();

-- ============================
-- HELPFUL VIEWS
-- ============================

-- View for getting recent completed rides with participant info
CREATE OR REPLACE VIEW completed_rides_with_participants AS
SELECT 
  r.ride_id,
  r.ride_uuid,
  r.creator_id,
  r.start_time,
  r.completion_time,
  r.trip_duration_minutes,
  r.actual_fare,
  u.name as driver_name,
  u.username as driver_username,
  u.avg_rating as driver_rating,
  COUNT(DISTINCT jr.partner_id) as passenger_count
FROM Ride r
JOIN "User" u ON r.creator_id = u.user_id
LEFT JOIN Join_Request jr ON r.ride_id = jr.ride_id 
  AND (SELECT status FROM Request_Status_Log WHERE request_id = jr.request_id ORDER BY timestamp DESC LIMIT 1) = 'accepted'
WHERE r.status = 'completed'
GROUP BY r.ride_id, r.ride_uuid, r.creator_id, r.start_time, r.completion_time, 
         r.trip_duration_minutes, r.actual_fare, u.name, u.username, u.avg_rating;

-- View for getting user statistics
CREATE OR REPLACE VIEW user_statistics AS
SELECT 
  u.user_id,
  u.name,
  u.username,
  u.total_rides,
  u.avg_rating,
  (SELECT COUNT(*) FROM Rating WHERE ratee_id = u.user_id) as total_ratings,
  (SELECT COUNT(*) FROM Friend WHERE user1_id = u.user_id OR user2_id = u.user_id) as friend_count,
  (SELECT COUNT(*) FROM Notification WHERE user_id = u.user_id AND is_read = false) as unread_notifications,
  u.created_at,
  u.updated_at
FROM "User" u;

-- ============================
-- TRIGGER INFORMATION
-- ============================

-- To see all triggers in the database:
-- SELECT * FROM information_schema.triggers WHERE trigger_schema = 'public';

-- To see function source code:
-- SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'function_name';
