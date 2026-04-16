-- Migration: Add passenger reports table for creator moderation actions
-- Date: 2026-04-16

CREATE TABLE IF NOT EXISTS Passenger_Report (
  report_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ride_id INT NOT NULL,
  request_id INT,
  reporter_user_id INT NOT NULL,
  reported_user_id INT NOT NULL,
  reason VARCHAR(100) NOT NULL,
  details TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_passenger_report_ride FOREIGN KEY (ride_id) REFERENCES Ride(ride_id) ON DELETE CASCADE,
  CONSTRAINT fk_passenger_report_request FOREIGN KEY (request_id) REFERENCES Join_Request(request_id) ON DELETE SET NULL,
  CONSTRAINT fk_passenger_report_reporter FOREIGN KEY (reporter_user_id) REFERENCES "User"(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_passenger_report_reported FOREIGN KEY (reported_user_id) REFERENCES "User"(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_passenger_report_ride ON Passenger_Report(ride_id);
CREATE INDEX IF NOT EXISTS idx_passenger_report_reported_user ON Passenger_Report(reported_user_id);
CREATE INDEX IF NOT EXISTS idx_passenger_report_created_at ON Passenger_Report(created_at);
