-- =========================
-- MERGED SCHEMA + MIGRATIONS
-- Generated on 2026-02-03
-- =========================

-- =========================
-- SCHEMA
-- =========================
-- =========================
-- DROP EXISTING OBJECTS
-- =========================
DROP TABLE IF EXISTS Rating CASCADE;
DROP TABLE IF EXISTS Payment_Status_Log CASCADE;
DROP TABLE IF EXISTS Payment CASCADE;
DROP TABLE IF EXISTS Message CASCADE;
DROP TABLE IF EXISTS Chat_Participants CASCADE;
DROP TABLE IF EXISTS Chat CASCADE;
DROP TABLE IF EXISTS Request_Status_Log CASCADE;
DROP TABLE IF EXISTS Join_Request CASCADE;
DROP TABLE IF EXISTS Ride_Status_Log CASCADE;
DROP TABLE IF EXISTS Ride CASCADE;
DROP TABLE IF EXISTS Location_Info CASCADE;
DROP TABLE IF EXISTS Friend_Request_Status_Log CASCADE;
DROP TABLE IF EXISTS Friend_Request CASCADE;
DROP TABLE IF EXISTS Friend CASCADE;
DROP TABLE IF EXISTS Auth CASCADE;
DROP TABLE IF EXISTS "User" CASCADE;

DROP TYPE IF EXISTS chat_role_enum CASCADE;
DROP TYPE IF EXISTS chat_type_enum CASCADE;
DROP TYPE IF EXISTS payment_status_enum CASCADE;
DROP TYPE IF EXISTS request_status_enum CASCADE;
DROP TYPE IF EXISTS ride_status_enum CASCADE;
DROP TYPE IF EXISTS ride_provider_enum CASCADE;
DROP TYPE IF EXISTS transport_mode_enum CASCADE;
DROP TYPE IF EXISTS auth_provider_enum CASCADE;
DROP TYPE IF EXISTS gender_enum CASCADE;

-- =========================
-- EXTENSIONS
-- =========================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =========================
-- ENUM TYPES
-- =========================
CREATE TYPE gender_enum AS ENUM ('male', 'female', 'other');
CREATE TYPE auth_provider_enum AS ENUM ('facebook', 'google');
CREATE TYPE ride_status_enum AS ENUM ('unactive', 'started', 'cancelled', 'completed', 'expired');
CREATE TYPE request_status_enum AS ENUM ('pending', 'accepted', 'rejected', 'cancelled');
CREATE TYPE payment_status_enum AS ENUM ('pending', 'completed', 'failed');
CREATE TYPE chat_type_enum AS ENUM ('private', 'group', 'ride');
CREATE TYPE chat_role_enum AS ENUM ('creator', 'partner', 'friend', 'requester');
CREATE TYPE transport_mode_enum AS ENUM ('Car', 'CNG', 'Bus', 'Bike');
CREATE TYPE ride_provider_enum AS ENUM ('Private', 'Uber', 'Pathao', 'Other');

-- =========================
-- USER
-- =========================
CREATE TABLE "User" (
    user_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),
    username VARCHAR(30) UNIQUE,
    name VARCHAR(100),
    gender gender_enum,
    profile_bio VARCHAR(255),
    avg_rating DECIMAL(3,2),
    phone VARCHAR(20),
    avatar_url VARCHAR(500),
    total_rides INT DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    university VARCHAR(255),
    department VARCHAR(255),
    address VARCHAR(500),
    fb VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =========================
-- AUTH
-- =========================
CREATE TABLE Auth (
    auth_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id INT NOT NULL,
    password_hash VARCHAR(255),
    email VARCHAR(255) UNIQUE,
    auth_provider auth_provider_enum,
    last_login TIMESTAMP,
    is_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_auth_user
        FOREIGN KEY (user_id) REFERENCES "User"(user_id) ON DELETE CASCADE
);

-- =========================
-- FRIEND
-- =========================
CREATE TABLE Friend (
    user1_id INT NOT NULL,
    user2_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user1_id, user2_id),

    CONSTRAINT fk_friend_user1 FOREIGN KEY (user1_id) REFERENCES "User"(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_friend_user2 FOREIGN KEY (user2_id) REFERENCES "User"(user_id) ON DELETE CASCADE
);

-- =========================
-- FRIEND REQUEST
-- =========================
CREATE TABLE Friend_Request (
    request_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sender_id INT NOT NULL,
    receiver_id INT NOT NULL,
    status_id INT,
    request_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),

    CONSTRAINT fk_fr_sender FOREIGN KEY (sender_id) REFERENCES "User"(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_fr_receiver FOREIGN KEY (receiver_id) REFERENCES "User"(user_id) ON DELETE CASCADE
);

CREATE TABLE Friend_Request_Status_Log (
    log_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    friend_request_id INT NOT NULL,
    status request_status_enum,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_fr_log
        FOREIGN KEY (friend_request_id) REFERENCES Friend_Request(request_id) ON DELETE CASCADE
);

-- =========================
-- LOCATION INFO
-- =========================
CREATE TABLE Location_Info (
    location_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(255),
    address VARCHAR(255),
    latitude DECIMAL(9,6),
    longitude DECIMAL(9,6)
);

-- =========================
-- RIDE
-- =========================
CREATE TABLE Ride (
    ride_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    creator_id INT NOT NULL,
    start_location_id INT,
    dest_location_id INT,
    status_log_id INT,
    ride_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),
    route_polyline TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    start_time TIMESTAMP,
    gender_preference gender_enum,
    preference_notes VARCHAR(255),
    transport_mode transport_mode_enum,
    ride_provider ride_provider_enum,
    fare DECIMAL(10,2),
    available_seats INT,

    CONSTRAINT fk_ride_creator FOREIGN KEY (creator_id) REFERENCES "User"(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_ride_start FOREIGN KEY (start_location_id) REFERENCES Location_Info(location_id),
    CONSTRAINT fk_ride_dest FOREIGN KEY (dest_location_id) REFERENCES Location_Info(location_id)
);

CREATE TABLE Ride_Status_Log (
    log_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ride_id INT NOT NULL,
    status ride_status_enum,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_ride_status FOREIGN KEY (ride_id) REFERENCES Ride(ride_id) ON DELETE CASCADE
);

-- =========================
-- JOIN REQUEST
-- =========================
CREATE TABLE Join_Request (
    request_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ride_id INT NOT NULL,
    partner_id INT NOT NULL,
    start_location_id INT,
    dest_location_id INT,
    status_id INT,
    request_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),
    route_polyline TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_jr_ride FOREIGN KEY (ride_id) REFERENCES Ride(ride_id) ON DELETE CASCADE,
    CONSTRAINT fk_jr_user FOREIGN KEY (partner_id) REFERENCES "User"(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_jr_start FOREIGN KEY (start_location_id) REFERENCES Location_Info(location_id),
    CONSTRAINT fk_jr_dest FOREIGN KEY (dest_location_id) REFERENCES Location_Info(location_id)
);

CREATE TABLE Request_Status_Log (
    log_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id INT NOT NULL,
    status request_status_enum,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_request_status
        FOREIGN KEY (request_id) REFERENCES Join_Request(request_id) ON DELETE CASCADE
);

-- =========================
-- CHAT
-- =========================
CREATE TABLE Chat (
    chat_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ride_id INT,
    chat_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),
    type chat_type_enum,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_chat_ride FOREIGN KEY (ride_id) REFERENCES Ride(ride_id) ON DELETE CASCADE
);

CREATE TABLE Chat_Participants (
    chat_id INT NOT NULL,
    participant_id INT NOT NULL,
    role chat_role_enum,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chat_id, participant_id),

    CONSTRAINT fk_cp_chat FOREIGN KEY (chat_id) REFERENCES Chat(chat_id) ON DELETE CASCADE,
    CONSTRAINT fk_cp_user FOREIGN KEY (participant_id) REFERENCES "User"(user_id) ON DELETE CASCADE
);

CREATE TABLE Message (
    message_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chat_id INT NOT NULL,
    sender_id INT NOT NULL,
    message_uuid UUID DEFAULT uuid_generate_v4(),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    content TEXT,

    CONSTRAINT fk_msg_chat FOREIGN KEY (chat_id) REFERENCES Chat(chat_id) ON DELETE CASCADE,
    CONSTRAINT fk_msg_sender FOREIGN KEY (sender_id) REFERENCES "User"(user_id) ON DELETE CASCADE
);

-- =========================
-- NOTIFICATION
-- =========================
CREATE TABLE IF NOT EXISTS Notification (
    notification_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id INT NOT NULL,
    type VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    related_user_id INT,
    related_ride_id INT,
    ride_uuid UUID,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_notification_user FOREIGN KEY (user_id) REFERENCES "User"(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_notification_related_user FOREIGN KEY (related_user_id) REFERENCES "User"(user_id) ON DELETE SET NULL,
    CONSTRAINT fk_notification_related_ride FOREIGN KEY (related_ride_id) REFERENCES Ride(ride_id) ON DELETE SET NULL
);

-- =========================
-- PAYMENT
-- =========================
CREATE TABLE Payment (
    payment_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ride_id INT NOT NULL,
    payer_id INT NOT NULL,
    payment_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),
    amount DECIMAL(10,2),
    distance DECIMAL(6,2),

    CONSTRAINT fk_payment_ride FOREIGN KEY (ride_id) REFERENCES Ride(ride_id) ON DELETE CASCADE,
    CONSTRAINT fk_payment_user FOREIGN KEY (payer_id) REFERENCES "User"(user_id) ON DELETE CASCADE
);

CREATE TABLE Payment_Status_Log (
    log_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    payment_id INT NOT NULL,
    status payment_status_enum,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_payment_status
        FOREIGN KEY (payment_id) REFERENCES Payment(payment_id) ON DELETE CASCADE
);

-- =========================
-- RATING
-- =========================
CREATE TABLE Rating (
    rating_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ride_id INT NOT NULL,
    rater_id INT NOT NULL,
    ratee_id INT NOT NULL,
    rating_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),
    rating INT CHECK (rating BETWEEN 1 AND 5),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_rating_ride FOREIGN KEY (ride_id) REFERENCES Ride(ride_id) ON DELETE CASCADE,
    CONSTRAINT fk_rating_rater FOREIGN KEY (rater_id) REFERENCES "User"(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_rating_ratee FOREIGN KEY (ratee_id) REFERENCES "User"(user_id) ON DELETE CASCADE
);

-- =========================
-- INDEXES
-- =========================
CREATE INDEX idx_user_username ON "User"(username);
CREATE INDEX idx_user_uuid ON "User"(user_uuid);
CREATE INDEX idx_auth_email ON Auth(email);
CREATE INDEX idx_auth_user_id ON Auth(user_id);
CREATE INDEX idx_ride_creator ON Ride(creator_id);
CREATE INDEX idx_ride_uuid ON Ride(ride_uuid);
CREATE INDEX idx_ride_start_time ON Ride(start_time);
CREATE INDEX idx_join_request_ride ON Join_Request(ride_id);
CREATE INDEX idx_join_request_partner ON Join_Request(partner_id);
CREATE INDEX idx_chat_ride ON Chat(ride_id);
CREATE INDEX idx_message_chat ON Message(chat_id);
CREATE INDEX idx_payment_ride ON Payment(ride_id);
CREATE INDEX idx_rating_ride ON Rating(ride_id);

-- =========================
-- MIGRATION: 001_add_ride_completion_fields.sql
-- =========================
-- Migration: Add Ride Completion Fields
-- Date: 2026-02-03
-- Description: Add fields for tracking ride completion, actual fare, and duration

ALTER TABLE Ride 
ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'unactive',
ADD COLUMN IF NOT EXISTS actual_fare DECIMAL(10,2),
ADD COLUMN IF NOT EXISTS completion_time TIMESTAMP,
ADD COLUMN IF NOT EXISTS trip_duration_minutes INT,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Create index for status queries
CREATE INDEX IF NOT EXISTS idx_ride_status ON Ride(status);
CREATE INDEX IF NOT EXISTS idx_ride_creator_id ON Ride(creator_id);
CREATE INDEX IF NOT EXISTS idx_ride_start_time ON Ride(start_time);

-- Create Notification table if missing
CREATE TABLE IF NOT EXISTS Notification (
  notification_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INT NOT NULL,
  type VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  related_user_id INT,
  related_ride_id INT,
  ride_uuid UUID,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_notification_user FOREIGN KEY (user_id) REFERENCES "User"(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_notification_related_user FOREIGN KEY (related_user_id) REFERENCES "User"(user_id) ON DELETE SET NULL,
  CONSTRAINT fk_notification_related_ride FOREIGN KEY (related_ride_id) REFERENCES Ride(ride_id) ON DELETE SET NULL
);

-- Verify Notification table has ride_uuid or appropriate fields
ALTER TABLE IF EXISTS Notification
ADD COLUMN IF NOT EXISTS ride_uuid UUID,
ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Create index for notification queries
CREATE INDEX IF NOT EXISTS idx_notification_user_id ON Notification(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_is_read ON Notification(is_read);
CREATE INDEX IF NOT EXISTS idx_notification_created_at ON Notification(created_at);

-- Update trigger to set updated_at on Ride updates
CREATE OR REPLACE FUNCTION update_ride_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_ride_timestamp_trigger ON Ride;

CREATE TRIGGER update_ride_timestamp_trigger
BEFORE UPDATE ON Ride
FOR EACH ROW
EXECUTE FUNCTION update_ride_timestamp();

-- =========================
-- MIGRATION: 002_add_chat_system_fields.sql
-- =========================
-- Migration: Add Chat System Fields
-- Date: 2026-02-03
-- Description: Add missing fields to Chat and Message tables for proper functioning

-- Add missing fields to Chat table if they don't exist
ALTER TABLE Chat
ADD COLUMN IF NOT EXISTS created_by INT REFERENCES "User"(user_id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Add missing fields to Message table if they don't exist
ALTER TABLE Message
ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_chat_created_by ON Chat(created_by);
CREATE INDEX IF NOT EXISTS idx_chat_created_at ON Chat(created_at);
CREATE INDEX IF NOT EXISTS idx_message_chat_id ON Message(chat_id);
CREATE INDEX IF NOT EXISTS idx_message_sender_id ON Message(sender_id);
CREATE INDEX IF NOT EXISTS idx_message_is_read ON Message(is_read);
CREATE INDEX IF NOT EXISTS idx_message_created_at ON Message(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_participants_chat_id ON Chat_Participants(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_participants_participant_id ON Chat_Participants(participant_id);

-- Update trigger to set updated_at on Chat updates
CREATE OR REPLACE FUNCTION update_chat_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_chat_timestamp_trigger ON Chat;

CREATE TRIGGER update_chat_timestamp_trigger
BEFORE UPDATE ON Chat
FOR EACH ROW
EXECUTE FUNCTION update_chat_timestamp();

-- Update trigger to set updated_at on Message updates
CREATE OR REPLACE FUNCTION update_message_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_message_timestamp_trigger ON Message;

CREATE TRIGGER update_message_timestamp_trigger
BEFORE UPDATE ON Message
FOR EACH ROW
EXECUTE FUNCTION update_message_timestamp();

-- =========================
-- MIGRATION: 003_add_database_triggers.sql
-- =========================
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
