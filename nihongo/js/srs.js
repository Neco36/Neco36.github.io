// 間隔反復（SM-2 を簡単にしたもの）

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

export function newCardState() {
  return { ease: 2.5, interval: 0, reps: 0, lapses: 0, due: Date.now() };
}

export function grade(card, correct, now = Date.now()) {
  const c = { ...card };
  if (correct) {
    c.reps += 1;
    if (c.reps === 1) c.interval = 1;
    else if (c.reps === 2) c.interval = 3;
    else c.interval = Math.round(c.interval * c.ease);
    c.ease = Math.min(3.0, c.ease + 0.05);
    c.due = now + c.interval * DAY;
  } else {
    c.lapses += 1;
    c.reps = 0;
    c.interval = 0;
    c.ease = Math.max(1.3, c.ease - 0.2);
    c.due = now + 10 * MIN;
  }
  c.lastReviewed = now;
  return c;
}

export function isDue(card, now = Date.now()) {
  return card.due <= now;
}

export function isLearned(card) {
  return card.reps >= 3;
}
