ALTER TABLE test_feedback ADD COLUMN room_id uuid REFERENCES rooms(id);
ALTER TABLE test_feedback ADD COLUMN task_id uuid REFERENCES ai_tasks(id);
ALTER TABLE test_feedback ADD CONSTRAINT feedback_context_one CHECK(room_id IS NULL OR task_id IS NULL);
