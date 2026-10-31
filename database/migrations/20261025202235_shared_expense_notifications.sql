-- Activity is the durable notification source. Delivery receipts survive a
-- user's dismissal/deletion of the bell row, so reading does not recreate it.
ALTER TABLE shared_memberships ADD COLUMN IF NOT EXISTS notification_since TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE TABLE IF NOT EXISTS shared_delivery_receipts (
    activity_id UUID NOT NULL REFERENCES shared_activity(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (activity_id, user_id)
);
ALTER TABLE shared_delivery_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shared_delivery_receipts_isolation ON shared_delivery_receipts;
CREATE POLICY shared_delivery_receipts_isolation ON shared_delivery_receipts USING (
    (SELECT app_bypass_rls()) OR (user_id = (SELECT app_current_user_id()) AND user_id = (SELECT app_real_user_id()))
) WITH CHECK (
    (SELECT app_bypass_rls()) OR (user_id = (SELECT app_current_user_id()) AND user_id = (SELECT app_real_user_id()))
);

-- Narrow fan-out projection: identifiers only, for a group this principal can
-- read, or their own backlog. Other users' notification bodies remain private.
CREATE OR REPLACE FUNCTION shared_pending_notifications(p_group UUID)
RETURNS TABLE (activity_id UUID, recipient_id UUID, group_id UUID, revoked BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, m.user_id, a.group_id, m.revoked_at IS NOT NULL
  FROM shared_activity a JOIN shared_memberships m ON m.group_id = a.group_id
  JOIN users u ON u.id = m.user_id AND u.is_active
  JOIN shared_groups g ON g.id = a.group_id
  WHERE app_current_user_id() = app_real_user_id() AND NOT g.is_detached_copy
    AND ((p_group IS NULL AND m.user_id = app_current_user_id())
      OR (p_group = a.group_id AND shared_group_role(p_group) IS NOT NULL))
    AND m.user_id IS DISTINCT FROM a.actor_user_id AND NOT m.muted
    AND a.created_at >= m.notification_since AND a.created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
    AND (
      (m.revoked_at IS NULL AND
        ((a.action IN ('ENTRY_CREATED', 'ENTRY_REVERSED') OR (a.action = 'ENTRY_UPDATED' AND a.detail->>'financialChanged' = 'true'))
           AND a.detail->'affectedParticipantIds' ? m.participant_id::text
         OR a.action IN ('MEMBER_JOINED', 'MEMBER_LEFT', 'OWNER_TRANSFERRED')))
      OR (a.action IN ('MEMBER_UPDATED', 'MEMBER_REVOKED', 'REMINDER_SENT') AND a.detail->>'participantId' = m.participant_id::text
        AND (m.revoked_at IS NULL OR (a.action = 'MEMBER_REVOKED' AND a.created_at <= m.revoked_at)))
    )
    AND NOT EXISTS (SELECT 1 FROM shared_delivery_receipts r WHERE r.activity_id = a.id AND r.user_id = m.user_id)
    AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = m.user_id AND n.dedupe_key = 'shared:' || a.id::text)
  ORDER BY a.created_at, a.id, m.user_id LIMIT 250
$$;
