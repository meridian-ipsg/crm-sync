// Engagement scoring config (Meridian Phase 9). Every weight/threshold here
// is a starting hypothesis per Mark's relative priority (tender/event views
// highest, Strategic Assessment reads moderate, topic concentration lower
// per-instance but cumulative), not a rigorous derivation - deliberately
// env-overridable so it can be tuned against real usage without a redeploy
// of logic. See connectors/posthog.ts for how these combine into a score.

// Every event type here must exist as a real PostHog event name captured by
// the website (see meridian-insights-website's TrackEvent usages). Adding a
// new weighted signal (e.g. Phase 18's content_saved) is meant to be just
// adding a key here plus one weight - no change to the scoring algorithm.
export type PerInstanceEventType = 'tender_detail_view' | 'event_detail_view' | 'strategic_assessment_read';

export const PER_INSTANCE_EVENT_TYPES: PerInstanceEventType[] = [
  'tender_detail_view',
  'event_detail_view',
  'strategic_assessment_read',
];

export interface EngagementConfig {
  lookbackDays: number;
  weights: Record<PerInstanceEventType, number> & { topicConcentration: number };
  concentration: { minTouchesPerTopic: number };
  highThreshold: number;
  markWorkspaceMemberId: string;
  taskMarkerPrefix: string;
}

function num(env: string, def: number): number {
  const raw = process.env[env];
  return raw != null && raw !== '' ? Number(raw) : def;
}

export const engagementConfig: EngagementConfig = {
  lookbackDays: num('ENGAGEMENT_LOOKBACK_DAYS', 30),
  weights: {
    tender_detail_view: num('WEIGHT_TENDER_VIEW', 10),
    event_detail_view: num('WEIGHT_EVENT_VIEW', 10),
    strategic_assessment_read: num('WEIGHT_ASSESSMENT_READ', 5),
    topicConcentration: num('WEIGHT_TOPIC_CONCENTRATION', 2),
  },
  concentration: {
    minTouchesPerTopic: num('CONCENTRATION_MIN_TOUCHES', 3),
  },
  highThreshold: num('ENGAGEMENT_HIGH_THRESHOLD', 40),
  markWorkspaceMemberId: process.env.MARK_WORKSPACE_MEMBER_ID || '395f078f-a093-4b33-a908-3f13dde620d4',
  taskMarkerPrefix: process.env.ENGAGEMENT_TASK_PREFIX || '[Engagement]',
};
