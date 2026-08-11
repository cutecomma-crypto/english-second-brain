// SM-2 spaced repetition, plus a P3 priority weighting layer on top
// (see PRD Stage 02.6 / 03.4): overdue-ness combined with how isolated
// a node is in the knowledge network — isolated nodes surface first.

export function nextReviewState(prev, rating) {
  let { ease_factor = 2.5, interval_days = 0, repetitions = 0, lapse_count = 0 } = prev;
  const interval_before = interval_days;

  // 「不知道」（完全沒印象）跟「忘記了」（有印象但答錯）在畫面上是分開的
  // 按鈕，但對排程演算法來說是同一件事：都算沒通過，重設連續答對次數，
  // 短時間內重新排進複習佇列。
  if (rating === "again" || rating === "unknown") {
    repetitions = 0;
    lapse_count += 1;
    interval_days = 1;
    ease_factor = Math.max(1.3, ease_factor - 0.2);
  } else {
    repetitions += 1;
    if (rating === "hard") {
      ease_factor = Math.max(1.3, ease_factor - 0.15);
      interval_days = repetitions === 1 ? 1 : Math.round(interval_days * 1.2);
    } else if (rating === "good") {
      if (repetitions === 1) interval_days = 1;
      else if (repetitions === 2) interval_days = 3;
      else interval_days = Math.round(interval_days * ease_factor);
    } else if (rating === "easy") {
      ease_factor = ease_factor + 0.15;
      interval_days = repetitions === 1 ? 2 : Math.round(interval_days * ease_factor * 1.3);
    }
  }

  interval_days = Math.max(1, interval_days);
  const due = new Date();
  due.setDate(due.getDate() + interval_days);

  return {
    ease_factor: Math.round(ease_factor * 100) / 100,
    interval_days,
    repetitions,
    lapse_count,
    due_at: due.toISOString().slice(0, 10),
    last_reviewed_at: new Date().toISOString(),
    interval_before,
  };
}

function daysOverdue(dueAtStr) {
  const due = new Date(dueAtStr + "T00:00:00");
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00");
  return Math.round((today - due) / 86400000);
}

// Higher score = more urgent to review.
export function priorityScore(reviewState, edgeCount) {
  const overdue = Math.max(0, daysOverdue(reviewState.due_at));
  const isolation = 1 / (1 + edgeCount); // 0 edges -> 1.0, many edges -> ~0
  return (overdue + 1) * (1 + isolation * 2);
}

// 共用的「包裝＋算優先分數＋排序」步驟，三種佇列建構方式都靠這個。
function toScoredQueue(nodes, reviewStates, edgeCounts) {
  return nodes
    .map((n) => ({
      node: n,
      reviewState: reviewStates.get(n.id),
      edgeCount: edgeCounts.get(n.id) || 0,
    }))
    .map((item) => ({ ...item, score: priorityScore(item.reviewState, item.edgeCount) }))
    .sort((a, b) => b.score - a.score);
}

export function buildReviewQueue(nodes, reviewStates, edgeCounts) {
  const today = new Date().toISOString().slice(0, 10);
  const due = nodes.filter((n) => {
    const rs = reviewStates.get(n.id);
    return rs && rs.due_at <= today;
  });
  return toScoredQueue(due, reviewStates, edgeCounts);
}

// 不篩到期日，把給定的節點全部組成佇列——課程複習用這個：
// 「這堂課的字」不論到期與否，使用者主動要求全部練一遍。
export function buildQueueForNodes(nodes, reviewStates, edgeCounts) {
  return toScoredQueue(
    nodes.filter((n) => reviewStates.get(n.id)),
    reviewStates,
    edgeCounts
  );
}

/* ----------------------------------------------------------------
   產品健檢 Phase 1：複習狀態分類 ＋ 可篩選的複習佇列
   這一段不是新演算法，是把既有 ReviewState 欄位「翻譯」成人看得懂
   的狀態標籤，並提供一個不受 due_at 限制的佇列建構方式——「需要加強」
   的字本來就不該等到正式到期才能練習。
   ---------------------------------------------------------------- */

export const REVIEW_STATUS = {
  NEW: "new", // 從未複習過
  NEEDS_REINFORCEMENT: "needs_reinforcement", // 上次複習被評為「Again」，repetitions 因此歸零
  LEARNING: "learning", // 複習過，正在累積連續答對次數
  FAMILIAR: "familiar", // 連續答對達門檻，間隔已經拉長
};

const FAMILIAR_REPETITIONS = 3;

export function classifyReviewState(reviewState) {
  if (!reviewState || !reviewState.last_reviewed_at) return REVIEW_STATUS.NEW;
  if (reviewState.repetitions === 0) return REVIEW_STATUS.NEEDS_REINFORCEMENT;
  if (reviewState.repetitions >= FAMILIAR_REPETITIONS) return REVIEW_STATUS.FAMILIAR;
  return REVIEW_STATUS.LEARNING;
}

// 自主單字功能用的「學習狀態」顯示——直接沿用上面已經在算的分類，只是換成
// 使用者要的顏色圖示，不是自己勾選的狀態，是複習表現算出來的，避免「看得
// 懂答案＝學會了」的假象。
const REVIEW_STATUS_LABEL = {
  [REVIEW_STATUS.NEW]: "🟡 接觸過",
  [REVIEW_STATUS.NEEDS_REINFORCEMENT]: "🟠 學習中",
  [REVIEW_STATUS.LEARNING]: "🟠 學習中",
  [REVIEW_STATUS.FAMILIAR]: "🟢 熟悉",
};

export function reviewStatusLabel(status) {
  return REVIEW_STATUS_LABEL[status] || status;
}

// 依狀態篩選節點、依優先分數排序——刻意不看 due_at，因為「需要加強」
// 或「課程複習」這類情境，是使用者主動要求練習，不是照表定排程走。
export function buildStatusQueue(nodes, reviewStates, edgeCounts, status) {
  const matching = nodes.filter((n) => classifyReviewState(reviewStates.get(n.id)) === status);
  return toScoredQueue(matching, reviewStates, edgeCounts);
}

// 統計今天的複習組成——今日複習總覽（Phase 2 的畫面）會直接用這個。
export function summarizeToday(nodes, reviewStates, edgeCounts) {
  const dueQueue = buildReviewQueue(nodes, reviewStates, edgeCounts);
  const needsReinforcement = buildStatusQueue(nodes, reviewStates, edgeCounts, REVIEW_STATUS.NEEDS_REINFORCEMENT);
  const dueIds = new Set(dueQueue.map((item) => item.node.id));
  return {
    dueCount: dueQueue.length,
    needsReinforcementCount: needsReinforcement.length,
    // 「需要加強」但恰好也到期的，不要算兩次。
    needsReinforcementOverlapCount: needsReinforcement.filter((item) => dueIds.has(item.node.id)).length,
  };
}
