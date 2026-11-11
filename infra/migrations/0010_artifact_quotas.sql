ALTER TABLE artifact_uploads
  ADD COLUMN content_started_at timestamptz,
  ADD COLUMN receiving_token uuid,
  ADD COLUMN receiving_until timestamptz,
  ADD COLUMN storage_released_at timestamptz;
UPDATE artifact_uploads SET content_started_at=created_at WHERE object_digest IS NOT NULL OR status<>'pending';
CREATE INDEX artifact_upload_quota ON artifact_uploads(environment_id,owner_id) WHERE storage_released_at IS NULL;
