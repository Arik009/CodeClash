import { practiceSlotCap } from '@codeclash/shared';

/** Practice keeps its 20% share; with no contest backlog it may borrow one idle slot. */
export function canTakePractice(totalSlots: number, contestRunning: boolean, practiceInflight: number, contestBacklog = 1) {
  const cap = practiceSlotCap(totalSlots, contestRunning);
  if (practiceInflight < cap) return true;
  return contestBacklog === 0 && practiceInflight < Math.max(1, cap);
}

export function nextStream(contestPending: boolean, practiceAllowed: boolean): 'judge:contest' | 'judge:practice' | null {
  if (contestPending) return 'judge:contest';
  if (practiceAllowed) return 'judge:practice';
  return null;
}
