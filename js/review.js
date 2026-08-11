import * as db from "./db.js";
import { buildReviewQueue, buildStatusQueue, buildQueueForNodes, summarizeToday, nextReviewState, REVIEW_STATUS } from "./sm2.js";
import { RATINGS, relationLabel, typeLabel } from "./constants.js";
import { toast } from "./panels.js";

const MODES = [
  { value: "flashcard", label: "字卡" },
  { value: "spelling", label: "拼字" },
  { value: "cloze", label: "例句填空" },
];

let reviewMode = "flashcard";
let queueSource = "due"; // "due" | "needs_reinforcement" — ignored while scopeCourseId is set
let scopeCourseId = null;
let scopeCourse = null; // fetched course record, for the banner label
let queue = [];
let total = 0;
let dueButIneligible = 0; // due nodes skipped because this mode can't use them (e.g. no example sentence)
let current = null;
let phase = "prompt"; // "prompt" (before checking) -> "checked" (showing result + rating)
let lastCheck = null; // { correct, correctAnswer } for spelling/cloze feedback
let todaySummary = { dueCount: 0, needsReinforcementCount: 0 };

export async function renderReview(container, { courseId = null } = {}) {
  scopeCourseId = courseId;
  scopeCourse = courseId ? await db.getCourse(courseId) : null;
  await loadQueue();
  paintShell(container);
}

async function loadQueue() {
  const nodes = scopeCourseId ? await db.getNodesForCourse(scopeCourseId) : await db.listNodes();
  const edgeCounts = await db.getEdgeCounts();
  const reviewStates = new Map(
    (await Promise.all(nodes.map(async (n) => [n.id, await db.getReviewState(n.id)]))).filter(([, rs]) => rs)
  );

  if (!scopeCourseId) {
    const allNodes = await db.listNodes();
    todaySummary = summarizeToday(allNodes, reviewStates, edgeCounts);
  }

  let base = scopeCourseId
    ? buildQueueForNodes(nodes, reviewStates, edgeCounts) // 課程複習：這堂課的字全部練，不看到期日
    : queueSource === "needs_reinforcement"
    ? buildStatusQueue(nodes, reviewStates, edgeCounts, REVIEW_STATUS.NEEDS_REINFORCEMENT)
    : buildReviewQueue(nodes, reviewStates, edgeCounts);

  // 文法練習目前用不到，複習佇列一律不收文法內容。
  base = base.filter((item) => item.node.type !== "grammar");

  if (reviewMode === "cloze") {
    queue = attachClozeSentences(base);
  } else {
    queue = base;
  }
  total = queue.length;
  dueButIneligible = base.length - queue.length;
  phase = "prompt";
  lastCheck = null;
}

function paintShell(container) {
  const scopeBannerHtml = scopeCourseId
    ? `<div class="review-scope-banner">
        <span>🔄 正在複習「${escapeHtml(scopeCourse?.title || "這堂課")}」的單字</span>
        <a href="#/review">✕ 結束，回到一般複習</a>
      </div>`
    : "";

  const sourceBarHtml = !scopeCourseId
    ? `<div class="review-source-bar review-source-bar-grid">
        <button type="button" class="review-source-btn ${queueSource === "due" ? "active" : ""}" data-source="due">
          📅 今日到期 <strong>${todaySummary.dueCount}</strong>
        </button>
        <button type="button" class="review-source-btn ${queueSource === "needs_reinforcement" ? "active" : ""}" data-source="needs_reinforcement">
          💪 需要加強 <strong>${todaySummary.needsReinforcementCount}</strong>
        </button>
      </div>`
    : "";

  // 原本三排各自散在頁面上的按鈕（狀態／類型／模式），收進同一個灰底控制列，
  // 小字統計也一起收進來，畫面焦點才能留給下面的字卡。
  const filterRowHtml = sourceBarHtml ? `<div class="review-control-row">${sourceBarHtml}</div>` : "";

  container.innerHTML = `
    <div class="review-wrap">
      ${scopeBannerHtml}
      <div class="review-control-bar">
        ${filterRowHtml}
        <div class="review-control-row">
          <div class="review-mode-bar">
            ${MODES.map(
              (m) =>
                `<button type="button" class="review-mode-btn ${m.value === reviewMode ? "active" : ""}" data-mode="${m.value}">${m.label}</button>`
            ).join("")}
          </div>
          <div class="review-progress-inline" id="review-progress"></div>
        </div>
      </div>
      <div id="review-body"></div>
    </div>
  `;

  container.querySelectorAll("[data-mode]").forEach((btn) => {
    btn.onclick = async () => {
      if (btn.dataset.mode === reviewMode) return;
      reviewMode = btn.dataset.mode;
      await loadQueue();
      paintShell(container);
    };
  });
  container.querySelectorAll("[data-source]").forEach((btn) => {
    btn.onclick = async () => {
      if (btn.dataset.source === queueSource) return;
      queueSource = btn.dataset.source;
      await loadQueue();
      paintShell(container);
    };
  });
  renderNext(container);
}

function getBody(container) {
  return container.querySelector("#review-body");
}

// 小字統計現在收在頂部控制列裡（見 paintShell），跟卡片內容分開更新。
function updateProgressLine(container, edgeCount) {
  const el = container.querySelector("#review-progress");
  if (!el) return;
  const done = total - queue.length;
  const modeNote = reviewMode === "cloze" ? `　·　只收錄有例句的內容` : "";
  const sourceNote = scopeCourseId ? "" : queueSource === "needs_reinforcement" ? "　·　需要加強佇列" : "";
  const edgeNote = edgeCount != null ? `　·　關聯數 ${edgeCount}` : "";
  el.textContent = `今日複習 · ${done} / ${total}　·　佇列 ${queue.length}${edgeNote}${modeNote}${sourceNote}`;
}

async function renderNext(container) {
  const body = getBody(container);
  if (queue.length === 0) {
    body.innerHTML = renderComplete();
    updateProgressLine(container);
    const btn = body.querySelector("[data-goto-graph]");
    if (btn) btn.onclick = () => (location.hash = "#/graph");
    return;
  }
  current = queue[0];
  phase = "prompt";
  lastCheck = null;
  await paint(container);
}

/* ---------------- cloze (example-sentence fill-in-the-blank) ---------------- */

function makeCloze(sentenceText, targetWord) {
  const escaped = targetWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "i");
  if (!re.test(sentenceText)) return null;
  return sentenceText.replace(re, "＿＿＿＿＿");
}

// 例句是單字/片語/文法自己的欄位，不再是獨立的句子節點，所以不用查關聯，
// 直接在欄位文字裡找一行含有 headword 的句子就好。單字的例句現在是每個
// 詞性各自一個（senses[].example），片語/文法/健檢前的舊單字資料則還是
// 用整字共用的 examples 欄位，兩邊都收集起來一起找。
function findCloze(node) {
  const lines = [];
  if (node.examples) lines.push(...node.examples.split("\n"));
  if (node.senses?.length) lines.push(...node.senses.map((s) => s.example).filter(Boolean));
  const cleaned = lines.map((l) => l.trim()).filter(Boolean);
  for (const line of cleaned) {
    const clozeText = makeCloze(line, node.headword);
    if (clozeText) return { fullSentence: line, clozeText };
  }
  return null;
}

function attachClozeSentences(baseQueue) {
  return baseQueue.map((item) => ({ ...item, cloze: findCloze(item.node) })).filter((item) => item.cloze);
}

function normalizeAnswer(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/* ---------------- painting ---------------- */

async function paint(container) {
  const body = getBody(container);
  const { node, edgeCount } = current;
  updateProgressLine(container, edgeCount);
  const isGrammar = node.type === "grammar";

  let frontHtml = "";
  let inputRow = "";

  if (reviewMode === "flashcard") {
    frontHtml = isGrammar
      ? `
        <div class="headword">${escapeHtml(node.headword)}</div>
        ${node.pattern ? `<div class="translation">${escapeHtml(node.pattern)}</div>` : ""}
        ${node.signal_words ? `<div class="pos">🔑 ${escapeHtml(node.signal_words)}</div>` : ""}
      `
      : `
        <div class="headword">${escapeHtml(node.headword)}</div>
        ${
          phase === "checked"
            ? `<div class="translation">${escapeHtml(node.translation || "（尚未填寫）")}</div>
               ${node.pronunciation ? `<div class="pos">${escapeHtml(node.pronunciation)}</div>` : ""}`
            : ""
        }
      `;
    inputRow =
      phase === "prompt" ? `<button class="btn btn-accent review-reveal-btn" id="reveal-btn">顯示答案</button>` : "";
  } else if (reviewMode === "spelling") {
    frontHtml = `
      <div class="translation" style="font-size:1.3rem;">${escapeHtml(node.translation || "（尚未填寫）")}</div>
      ${
        phase === "checked"
          ? `<div class="spell-result ${lastCheck.correct ? "correct" : "wrong"}">
              ${lastCheck.correct ? "✅ 拼對了！" : `❌ 正確拼法：<strong>${escapeHtml(node.headword)}</strong>`}
            </div>`
          : ""
      }
    `;
    inputRow =
      phase === "prompt"
        ? `<div class="spell-input-row">
            <input type="text" id="answer-input" placeholder="輸入英文拼字…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
            <button class="btn btn-accent" id="check-btn">檢查</button>
          </div>`
        : "";
  } else if (reviewMode === "cloze") {
    const { cloze } = current;
    frontHtml = `
      <div class="cloze-sentence">${escapeHtml(cloze.clozeText)}</div>
      <div class="translation" style="font-size:1rem;">提示：${escapeHtml(node.translation || "")}</div>
      ${
        phase === "checked"
          ? `<div class="spell-result ${lastCheck.correct ? "correct" : "wrong"}">
              ${lastCheck.correct ? "✅ 答對了！" : `❌ 正確答案：<strong>${escapeHtml(node.headword)}</strong>`}
            </div>
            <div class="cloze-full">${escapeHtml(cloze.fullSentence)}</div>`
          : ""
      }
    `;
    inputRow =
      phase === "prompt"
        ? `<div class="spell-input-row">
            <input type="text" id="answer-input" placeholder="填入空格的單字…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
            <button class="btn btn-accent" id="check-btn">檢查</button>
          </div>`
        : "";
  }

  let extraHtml = "";
  if (phase === "checked") {
    const edges = await db.getEdgesForNode(node.id);
    const relatedNodes = await Promise.all(
      edges.map((e) => db.getNode(e.from_node_id === node.id ? e.to_node_id : e.from_node_id))
    );
    // 單字的例句是每個詞性各自一個；有的話優先顯示，沒有才退回舊的整字共用欄位。
    const senseExamples = node.senses?.length ? node.senses.filter((s) => s.example) : [];
    const examplesHtml = senseExamples.length
      ? `<div class="notes-block"><h4>例句</h4>${senseExamples
          .map(
            (s) =>
              `<div class="layer-entry"><span class="txt">${s.part_of_speech ? `<strong>${escapeHtml(s.part_of_speech)}</strong> ` : ""}${escapeHtml(s.example)}</span></div>`
          )
          .join("")}</div>`
      : node.examples
      ? `<div class="notes-block"><h4>${isGrammar ? "核心例句與解析" : "例句"}</h4><div class="layer-entry"><span class="txt" style="white-space:pre-wrap;">${escapeHtml(node.examples)}</span></div></div>`
      : "";
    extraHtml = `
      <div class="review-answer-extra">
        ${
          node.supplement_note
            ? `<div class="notes-block">
                <h4>${isGrammar ? "用法說明" : "我的補充"}</h4>
                <div class="layer-entry"><span class="txt">${escapeHtml(node.supplement_note)}</span></div>
              </div>`
            : ""
        }
        ${examplesHtml}
        ${node.caution_note ? `<div class="notes-block"><h4>⚠️ ${isGrammar ? "常見錯誤 / 易混淆對比" : "易錯提醒"}</h4><div class="layer-entry"><span class="txt">${escapeHtml(node.caution_note)}</span></div></div>` : ""}
        ${
          edges.length
            ? `<div class="related-block">
                <h4>關聯（${edges.length}）</h4>
                <div class="related-list">
                  ${edges
                    .map((e, i) => {
                      const other = relatedNodes[i];
                      if (!other) return "";
                      return `<div class="related-item" data-jump="${other.id}">
                        <span class="type-badge type-${other.type}">${typeLabel(other.type)}</span>
                        <strong>${escapeHtml(other.headword)}</strong>
                        <span class="rel-note">${relationLabel(e.relation_type)}</span>
                      </div>`;
                    })
                    .join("")}
                </div>
              </div>`
            : ""
        }
      </div>`;
  }

  body.innerHTML = `
    <div class="review-card">
      <span class="type-badge type-${node.type}">${typeLabel(node.type)}</span>
      ${frontHtml}
      ${extraHtml}
    </div>
    <div class="review-actions">
      ${inputRow}
      ${
        phase === "checked"
          ? `<div class="rating-row">
              ${RATINGS.map((r) => `<button class="rating-btn ${r.cls}" data-rate="${r.value}">${r.label}<small>${r.hint}</small></button>`).join("")}
            </div>`
          : ""
      }
    </div>
  `;

  if (reviewMode === "flashcard" && phase === "prompt") {
    body.querySelector("#reveal-btn").onclick = () => {
      phase = "checked";
      paint(container);
    };
  } else if (phase === "prompt" && (reviewMode === "spelling" || reviewMode === "cloze")) {
    const input = body.querySelector("#answer-input");
    const checkBtn = body.querySelector("#check-btn");
    const doCheck = () => {
      const correct = normalizeAnswer(input.value) === normalizeAnswer(node.headword);
      lastCheck = { correct, correctAnswer: node.headword };
      phase = "checked";
      paint(container);
    };
    checkBtn.onclick = doCheck;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doCheck();
    });
    input.focus();
  }

  if (phase === "checked") {
    body.querySelectorAll("[data-rate]").forEach((btn) => {
      btn.onclick = () => submitRating(container, btn.dataset.rate);
    });
    body.querySelectorAll("[data-jump]").forEach((item) => {
      item.onclick = () => import("./panels.js").then((m) => m.openDetailPanel(item.dataset.jump));
    });
  }
}

async function submitRating(container, rating) {
  const { node, reviewState } = current;
  const updated = nextReviewState(reviewState, rating);
  await db.upsertReviewState(node.id, updated);
  await db.addReviewLog({
    node_id: node.id,
    rating,
    interval_before: updated.interval_before,
    interval_after: updated.interval_days,
  });
  queue.shift();
  await renderNext(container);
  updateDueBadge();
}

function renderComplete() {
  const skippedNote =
    total === 0 && dueButIneligible > 0
      ? reviewMode === "cloze"
        ? `<p class="hint">還有 ${dueButIneligible} 個到期內容，但因為沒有連結任何例句，例句填空模式用不上——可以到內容詳情幫它們加一個例句，或切換回「字卡」「拼字」複習。</p>`
        : reviewMode === "spelling"
        ? `<p class="hint">還有 ${dueButIneligible} 個到期內容，但文法內容沒有固定答案可以拼——可以切換回「字卡」複習。</p>`
        : ""
      : "";
  const label = scopeCourseId ? "這堂課" : queueSource === "needs_reinforcement" ? "需要加強的內容" : "今日";
  return `
    <div style="display:flex; flex-direction:column; align-items:center; text-align:center; gap:14px; padding-top:20px;">
      <div style="font-size:2.4rem;">✅</div>
      <h2 style="margin:0;">${label}複習完成</h2>
      <p class="hint">共複習了 ${total} 個內容。</p>
      ${skippedNote}
      <button class="btn btn-accent" data-goto-graph>回到圖譜</button>
    </div>
  `;
}

export async function updateDueBadge() {
  const nodes = await db.listNodes();
  const today = new Date().toISOString().slice(0, 10);
  let due = 0;
  for (const n of nodes) {
    const rs = await db.getReviewState(n.id);
    if (rs && rs.due_at <= today) due++;
  }
  const badge = document.getElementById("due-badge");
  if (due > 0) {
    badge.hidden = false;
    badge.textContent = due;
  } else {
    badge.hidden = true;
  }
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
