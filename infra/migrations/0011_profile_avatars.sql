ALTER TABLE users ADD COLUMN avatar_key text NOT NULL DEFAULT 'dice'
  CHECK(avatar_key IN ('dice','fox','cat','panda','robot','rocket','planet','star'));
