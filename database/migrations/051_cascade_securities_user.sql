-- Adds ON DELETE CASCADE to the securities.user_id foreign key so that
-- deleting a user removes their associated securities along with all the
-- other per-user data. Previously the constraint was NO ACTION, which
-- blocked user deletion whenever the user owned any securities.

ALTER TABLE securities
    DROP CONSTRAINT IF EXISTS securities_user_id_fkey;

ALTER TABLE securities
    ADD CONSTRAINT securities_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
