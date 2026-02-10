
-- Migration: Add Friend, Friend_Request, and Friend_Request_Status_Log tables

CREATE TABLE IF NOT EXISTS Friend (
  user1_id INT NOT NULL,
  user2_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user1_id, user2_id),
  CONSTRAINT fk_friend_user1 FOREIGN KEY (user1_id) REFERENCES "User"(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_friend_user2 FOREIGN KEY (user2_id) REFERENCES "User"(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS Friend_Request (
  request_id SERIAL PRIMARY KEY,
  sender_id INT NOT NULL,
  receiver_id INT NOT NULL,
  status_id INT,
  request_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),
  CONSTRAINT fk_fr_sender FOREIGN KEY (sender_id) REFERENCES "User"(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_fr_receiver FOREIGN KEY (receiver_id) REFERENCES "User"(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS Friend_Request_Status_Log (
  log_id SERIAL PRIMARY KEY,
  friend_request_id INT NOT NULL,
  status request_status_enum,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_fr_log FOREIGN KEY (friend_request_id) REFERENCES Friend_Request(request_id) ON DELETE CASCADE
);
