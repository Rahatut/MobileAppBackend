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
