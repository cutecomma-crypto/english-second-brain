import * as db from "./db.js";
import {
  NODE_TYPES,
  RELATION_TYPES,
  relationLabel,
  typeLabel,
  GRAMMAR_CATEGORIES,
  grammarCategoryLabel,
  grammarPreviewText,
  PHRASE_TYPES,
  phraseTypeLabel,
  WORD_POS,
} from "./constants.js";
import { classifyReviewState, reviewStatusLabel } from "./sm2.js";

let refreshApp = () => {};
export function setRefreshHandler(fn) {
  refreshApp = fn;
}
export function triggerRefresh() {
  refreshApp();
}

/* ============================================================
   Node Detail Panel (overlay, Flow C hub)
   ============================================================ */

const detailBackdrop = document.getElementById("overlay-detail");
const detailPanel = detailBackdrop.querySelector(".panel");

export async function openDetailPanel(nodeId) {
  const node = await db.getNode(nodeId);
  if (!node) {
    toast("這筆內容已經被刪除");
    return;
  }
  const [edges, courses, pendingQuestions, reviewState] = await Promise.all([
    db.getEdgesForNode(nodeId),
    db.getCoursesForNode(nodeId),
    db.getPendingQuestionsForNode(nodeId),
    db.getReviewState(nodeId),
  ]);
  const relatedIds = edges.map((e) => (e.from_node_id === nodeId ? e.to_node_id : e.from_node_id));
  const relatedNodes = await Promise.all(relatedIds.map((id) => db.getNode(id)));
  const relatedMap = new Map(relatedNodes.filter(Boolean).map((n) => [n.id, n]));
  const openPending = pendingQuestions.filter((q) => q.status === "open");

  detailPanel.innerHTML = renderDetail(node, edges, relatedMap, courses, openPending, reviewState);
  wireDetail(node, edges, relatedMap);
  detailBackdrop.hidden = false;
  history.replaceState(null, "", `${location.hash.split("?")[0]}?node=${nodeId}`);
}

export function closeDetailPanel() {
  detailBackdrop.hidden = true;
  history.replaceState(null, "", location.hash.split("?")[0]);
  refreshApp();
}

detailBackdrop.addEventListener("click", (e) => {
  if (e.target === detailBackdrop) closeDetailPanel();
});

function groupEdgesByRelation(edges) {
  const groups = new Map();
  for (const e of edges) {
    if (!groups.has(e.relation_type)) groups.set(e.relation_type, []);
    groups.get(e.relation_type).push(e);
  }
  return groups;
}

// 分類標籤只是篩選用，詳情頁單純把它當一個小標籤顯示；pattern 是健檢前
// 舊格式留下的欄位，新表單不再收集，只是讓舊資料的值不會消失。
function renderGrammarDetailHtml(node) {
  const categoryLine = node.grammar_category ? `<div class="pos-pron">${escapeHtml(grammarCategoryLabel(node.grammar_category))}</div>` : "";
  const patternLine = node.pattern ? `<p class="hint">🔑 核心公式：${escapeHtml(node.pattern)}</p>` : "";
  return categoryLine || patternLine ? `${categoryLine}${patternLine}` : "";
}

function renderDetail(node, edges, relatedMap, courses, openPending = [], reviewState = null) {
  const groups = groupEdgesByRelation(edges);
  const relatedHtml = [...groups.entries()]
    .map(
      ([rel, list]) => `
      <div class="related-group-label">${relationLabel(rel)}</div>
      <div class="related-list">
        ${list
          .map((e) => {
            const otherId = e.from_node_id === node.id ? e.to_node_id : e.from_node_id;
            const other = relatedMap.get(otherId);
            if (!other) return "";
            return `<div class="related-item" data-jump="${other.id}">
              <span class="type-badge type-${other.type}">${typeLabel(other.type)}</span>
              <strong>${escapeHtml(other.headword)}</strong>
              ${e.note ? `<span class="rel-note">${escapeHtml(e.note)}</span>` : ""}
              <button class="btn btn-sm btn-ghost" style="margin-left:auto;" data-del-edge="${e.id}" title="移除這條關聯">✕</button>
            </div>`;
          })
          .join("")}
      </div>`
    )
    .join("");

  // 「來源」現在有兩種：連到的課程（既有資料，nodeCourseLinks）跟自主單字
  // 標籤（新欄位）——兩者不衝突，一個字可以同時有兩種來源。
  const sourceItems = [
    ...courses.map(
      (c) => `<div class="related-item" data-jump-course="${c.id}">
        <span class="type-badge type-word">${escapeHtml(c.date || "")}</span>
        <strong>${escapeHtml(c.title || "未命名課程")}</strong>
      </div>`
    ),
    node.is_self_study
      ? `<div class="related-item" style="cursor:default;">
          <span class="type-badge type-word">📱</span>
          <strong>自主單字</strong>
        </div>`
      : "",
  ].filter(Boolean);
  const coursesHtml = sourceItems.length
    ? `<div class="related-list">${sourceItems.join("")}</div>`
    : `<p class="hint">還沒有任何來源課程——直接在課程詳情裡新增這個字，會自動連起來。</p>`;

  const pendingHtml = openPending.length
    ? `<div class="related-list">
        ${openPending
          .map((q) => {
            const preview = (q.content || "").slice(0, 40);
            return `<div class="related-item" data-jump-pending>
              <span class="type-badge type-word">🕓</span>
              <span>${escapeHtml(preview)}${(q.content || "").length > 40 ? "…" : ""}</span>
            </div>`;
          })
          .join("")}
      </div>`
    : "";

  const isGrammar = node.type === "grammar";
  const hasSenses = node.type === "word" && node.senses?.length;
  // 單字現在的例句是每個意思各自一個；健檢前留下的整字共用例句欄位只在
  // 還沒有任何意思填過例句時才當備援顯示，避免兩邊重複。
  const hasSenseExamples = hasSenses && node.senses.some((s) => s.example);
  const posLine =
    node.type === "phrase" && node.phrase_type
      ? phraseTypeLabel(node.phrase_type)
      : [node.part_of_speech, node.pronunciation].filter(Boolean).join(" · ");
  const headerMetaHtml = isGrammar
    ? renderGrammarDetailHtml(node)
    : hasSenses
    ? `${node.pronunciation ? `<div class="pos-pron">${escapeHtml(node.pronunciation)}</div>` : ""}
       <div class="translation senses-list">
         ${node.senses
           .map(
             (s) => `<div class="sense-detail-row">
               <div>${s.part_of_speech ? `<strong>${escapeHtml(s.part_of_speech)}</strong> ` : ""}${escapeHtml(s.translation)}</div>
               ${s.example ? `<div class="sense-example-line">${escapeHtml(s.example)}</div>` : ""}
             </div>`
           )
           .join("")}
       </div>`
    : `<div class="pos-pron">${escapeHtml(posLine) || "&nbsp;"}</div>
       <div class="translation">${escapeHtml(node.translation || "（尚未填寫翻譯）")}</div>`;

  return `
    <div class="panel-header">
      <span class="type-badge type-${node.type}">${typeLabel(node.type)}</span>
      <button class="panel-close" data-close>✕</button>
    </div>
    <h2>${escapeHtml(node.headword)}</h2>
    <div class="hint" style="margin:-6px 0 10px;">${escapeHtml(reviewStatusLabel(classifyReviewState(reviewState)))}</div>
    ${headerMetaHtml}

    <div class="panel-actions">
      <button class="btn btn-accent btn-sm" data-add-relation>＋ 新增關聯</button>
      <button class="btn btn-sm" data-edit-node>編輯基本資料</button>
      <button class="btn btn-sm" data-mark-pending>🕓 標記為待處理</button>
      <button class="btn btn-sm btn-danger" data-delete-node>刪除內容</button>
    </div>

    <div class="panel-section related-block">
      <h4>📚 出現於</h4>
      ${coursesHtml}
    </div>

    <div class="panel-section notes-block">
      <h4>${isGrammar ? "用法說明" : "我的補充"}</h4>
      <div class="field" style="margin-bottom:6px;">
        <textarea id="supplement-textarea" rows="4" placeholder="${isGrammar ? "這條規則的用法、強調重點、觸發情境……" : "老師額外說明、自己的理解、容易搞混的地方、記憶方法……自由記錄，不分類。"}">${escapeHtml(node.supplement_note || "")}</textarea>
      </div>
      <button class="btn btn-sm btn-accent" data-save-supplement>儲存補充</button>
    </div>

    ${
      node.synonyms?.length
        ? `<div class="panel-section"><h4>🔁 同義字</h4><div class="synonym-chips">${node.synonyms
            .map((s) => `<span class="synonym-chip synonym-chip-static">${escapeHtml(s)}</span>`)
            .join("")}</div></div>`
        : ""
    }
    ${node.examples && !hasSenseExamples ? `<div class="panel-section"><h4>📝 ${isGrammar ? "核心例句與解析" : "例句"}</h4><p class="hint" style="white-space:pre-wrap;">${escapeHtml(node.examples)}</p></div>` : ""}
    ${node.signal_words ? `<div class="panel-section"><h4>🔑 觸發關鍵字</h4><p class="hint">${escapeHtml(node.signal_words)}</p></div>` : ""}
    ${node.caution_note ? `<div class="panel-section"><h4>⚠️ ${isGrammar ? "常見錯誤 / 易混淆對比" : "易錯提醒"}</h4><p class="hint">${escapeHtml(node.caution_note)}</p></div>` : ""}

    ${
      openPending.length
        ? `<div class="panel-section related-block">
            <h4>❓ 待處理（${openPending.length}）</h4>
            ${pendingHtml}
          </div>`
        : ""
    }

    <div class="panel-section related-block">
      <h4>🔗 已確認關係（${edges.length}）</h4>
      ${relatedHtml || `<p class="hint">還沒有任何關聯——這是一個孤立內容，複習時會被優先排到。</p>`}
    </div>
  `;
}

function wireDetail(node, edges, relatedMap) {
  detailPanel.querySelector("[data-close]").onclick = closeDetailPanel;

  detailPanel.querySelector("[data-save-supplement]").onclick = async () => {
    const value = detailPanel.querySelector("#supplement-textarea").value;
    await db.updateNode(node.id, { supplement_note: value.trim() || null });
    toast("已儲存補充");
  };

  detailPanel.querySelectorAll("[data-del-edge]").forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      try {
        await db.deleteEdge(btn.dataset.delEdge);
        openDetailPanel(node.id);
        toast("已移除關聯");
      } catch (err) {
        toast(err.message || "移除失敗");
      }
    };
  });

  detailPanel.querySelectorAll("[data-jump]").forEach((item) => {
    item.onclick = () => openDetailPanel(item.dataset.jump);
  });

  detailPanel.querySelectorAll("[data-jump-course]").forEach((item) => {
    item.onclick = () => {
      closeDetailPanel();
      location.hash = `#/course?id=${item.dataset.jumpCourse}`;
    };
  });

  detailPanel.querySelectorAll("[data-jump-pending]").forEach((item) => {
    item.onclick = () => {
      closeDetailPanel();
      location.hash = "#/pending";
    };
  });

  detailPanel.querySelector("[data-add-relation]").onclick = () => {
    openEditorModal({ mode: "relation-only", fromNode: node });
  };

  detailPanel.querySelector("[data-edit-node]").onclick = () => {
    openEditorModal({ mode: "edit", node });
  };

  detailPanel.querySelector("[data-mark-pending]").onclick = () => {
    closeDetailPanel();
    location.hash = `#/pending?for_node=${node.id}`;
  };

  detailPanel.querySelector("[data-delete-node]").onclick = async () => {
    if (!confirm(`確定要刪除「${node.headword}」嗎？相關的關聯與課程連結也會一併刪除。`)) return;
    try {
      await db.deleteNode(node.id);
      closeDetailPanel();
      toast("已刪除內容");
    } catch (err) {
      toast(err.message || "刪除失敗");
    }
  };
}

/* ============================================================
   Add / Edit Node modal (Flow A — general + course-context variant)
   ============================================================ */

const editorBackdrop = document.getElementById("overlay-editor");
const editorModal = editorBackdrop.querySelector(".modal");

let pendingRelation = null; // { toNode, relation_type, note }
let editorCourseId = null; // set when opened from a course's "＋新增單字"
let editorSenses = []; // [{part_of_speech, translation}]，只有單字類型使用
let editorSynonyms = []; // string[]，只有單字類型使用

export function openEditorModal({ mode = "create", node = null, fromNode = null, courseId = null } = {}) {
  pendingRelation = null;
  editorCourseId = courseId;
  editorSenses = initialSenses(node);
  editorSynonyms = node?.synonyms ? [...node.synonyms] : [];
  editorModal.innerHTML = renderEditor(mode, node, fromNode);
  wireEditor(mode, node, fromNode);
  editorBackdrop.hidden = false;
  editorModal.querySelector('[name="headword"]')?.focus();
}

export function closeEditorModal() {
  editorBackdrop.hidden = true;
  pendingRelation = null;
  editorCourseId = null;
}

// 單字常常不只一種詞性、每種詞性翻譯不同——舊資料（只有單一 translation／
// part_of_speech）會自動變成一列，使用者可以直接在上面加更多列，
// 不需要另外跑遷移。
function initialSenses(node) {
  if (node?.senses?.length) return node.senses.map((s) => ({ ...s }));
  return [{ part_of_speech: node?.part_of_speech || "", translation: node?.translation || "", example: "" }];
}

editorBackdrop.addEventListener("click", (e) => {
  if (e.target === editorBackdrop) closeEditorModal();
});

function renderEditor(mode, node, fromNode) {
  const relationOnly = mode === "relation-only";
  const title = relationOnly ? `為「${fromNode.headword}」新增關聯` : mode === "edit" ? "編輯內容" : "新增內容";
  const initialType = node?.type || "word";

  return `
    <h2>${title}</h2>
    ${editorCourseId ? `<p class="hint" style="margin-top:-10px;margin-bottom:16px;">這個字會自動連結到目前這堂課</p>` : ""}
    <form id="editor-form">
      ${
        relationOnly
          ? ""
          : `
        ${
          mode === "create"
            ? `
        <div class="field">
          <label>類型</label>
          <div class="type-toggle" id="type-toggle">
            ${NODE_TYPES.map(
              (t) => `<button type="button" data-type="${t.value}" class="${t.value === initialType ? "active" : ""}">${t.label}</button>`
            ).join("")}
          </div>
        </div>`
            : ""
        }
        <div id="node-fields">${renderNodeFields(initialType, node, editorSenses)}</div>
      `
      }

      ${
        mode === "edit"
          ? ""
          : `
      <div class="field">
        <label>${relationOnly ? "搜尋要連結的內容" : "建議相關內容（選填，但建議建立）"}</label>
        <input type="text" id="relation-search" placeholder="輸入 headword 或翻譯搜尋…" autocomplete="off" />
        <div class="suggest-box" id="suggest-box"><div class="suggest-empty">開始輸入以搜尋既有內容</div></div>
        <div id="pending-relation-slot"></div>
      </div>`
      }

      <div class="modal-footer">
        <button type="button" class="btn" id="editor-cancel">取消</button>
        <button type="submit" class="btn btn-accent">${relationOnly ? "儲存關聯" : mode === "edit" ? "儲存變更" : "儲存內容"}</button>
      </div>
    </form>
  `;
}

function renderSensesList(senses) {
  return `
    <div id="senses-wrap">
      ${senses
        .map((s, i) => {
          // 舊資料可能存過不在標準八大詞性清單裡的值（例如合併寫的 "v./n."）；
          // 用一個額外的選項把原始值保留下來，不會因為換成下拉選單就悄悄消失。
          const isCustomPos = s.part_of_speech && !WORD_POS.some((p) => p.value === s.part_of_speech);
          return `
        <div class="sense-block">
          <div class="sense-row">
            <select class="sense-pos">
              <option value="">詞性</option>
              ${isCustomPos ? `<option value="${escapeAttr(s.part_of_speech)}" selected>${escapeHtml(s.part_of_speech)}（原始值）</option>` : ""}
              ${WORD_POS.map(
                (p) => `<option value="${p.value}" ${s.part_of_speech === p.value ? "selected" : ""}>${p.label}</option>`
              ).join("")}
            </select>
            <input type="text" class="sense-translation" placeholder="翻譯，例如 書" value="${escapeAttr(s.translation || "")}" />
            <button type="button" class="btn btn-sm btn-ghost" data-remove-sense="${i}" ${senses.length <= 1 ? "disabled" : ""} title="移除這個翻譯">✕</button>
          </div>
          <input type="text" class="sense-example" placeholder="這個意思的例句…" value="${escapeAttr(s.example || "")}" />
        </div>`;
        })
        .join("")}
      <button type="button" class="btn btn-sm" id="add-sense-btn">＋ 新增詞性／翻譯</button>
    </div>
  `;
}

// 同義字用標籤（chip）呈現——打字按 Enter 或點「＋新增」就變成一個標籤，
// 點標籤上的 ✕ 移除。純字串陣列，不分詞性（跟 senses 不一樣，同義字是
// 整個單字層級的，不特定對應某個意思）。
function renderSynonymsField(synonyms) {
  return `
    <div id="synonym-wrap">
      <div class="synonym-chips">
        ${synonyms
          .map(
            (s, i) =>
              `<span class="synonym-chip">${escapeHtml(s)}<button type="button" data-remove-synonym="${i}" title="移除">✕</button></span>`
          )
          .join("")}
      </div>
      <div class="synonym-add-row">
        <input type="text" id="synonym-input" placeholder="輸入同義字，按 Enter 或點新增……" autocomplete="off" />
        <button type="button" class="btn btn-sm" id="add-synonym-btn">＋ 新增</button>
      </div>
    </div>
  `;
}

function wireSynonymsWrap() {
  const wrap = editorModal.querySelector("#synonym-wrap");
  if (!wrap) return;
  wrap.querySelectorAll("[data-remove-synonym]").forEach((btn) => {
    btn.onclick = () => {
      editorSynonyms.splice(Number(btn.dataset.removeSynonym), 1);
      wrap.outerHTML = renderSynonymsField(editorSynonyms);
      wireSynonymsWrap();
    };
  });
  const input = wrap.querySelector("#synonym-input");
  const addFromInput = () => {
    const value = input.value.trim();
    if (value && !editorSynonyms.some((s) => s.toLowerCase() === value.toLowerCase())) {
      editorSynonyms.push(value);
    }
    wrap.outerHTML = renderSynonymsField(editorSynonyms);
    wireSynonymsWrap();
    editorModal.querySelector("#synonym-input")?.focus();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addFromInput();
    }
  });
  wrap.querySelector("#add-synonym-btn").onclick = addFromInput;
}

// 文法規則是獨立的知識類型，不跟單字/片語/句子共用欄位——但仍然是 Node，
// 所以跟課程、關聯、知識圖譜的連結方式完全不變，只有「新增/編輯時看到的
// 欄位」不一樣。分類標籤純粹用來篩選／瀏覽，不會改變下方欄位結構——
// 欄位對所有文法內容都一樣：標題、分類、核心說明、例句、常見搭配／
// 關鍵字、易錯提醒，維持「欄位乾淨、但保留分類與重點欄位」的平衡。
function renderNodeFields(type, node, senses) {
  if (type === "word") {
    // 單字常有多種詞性、每種翻譯不同（book：n. 書／v. 預訂），所以翻譯
    // 欄位是可以動態新增的「詞性＋翻譯」清單。片語／句子／文法不需要
    // 詞性這麼細的分類，各自用更簡單的欄位（見下面對應分支）。
    // 學習來源預設值：編輯既有單字就看它本來存的值；新增時如果是從課程頁
    // 「＋新增單字」點進來（editorCourseId 有值）就預設「家教課」，其他
    // 情況預設「自主單字」——都還是可以手動改。
    const defaultSelfStudy = node ? !!node.is_self_study : !editorCourseId;
    return `
      <div class="field">
        <label>單字 *</label>
        <input type="text" name="headword" value="${node ? escapeAttr(node.headword) : ""}" placeholder="輸入英文原文……" />
      </div>
      <div class="field">
        <label>學習來源</label>
        <div class="type-toggle" id="word-source-toggle">
          <button type="button" data-source="course" class="${!defaultSelfStudy ? "active" : ""}">家教課</button>
          <button type="button" data-source="self" class="${defaultSelfStudy ? "active" : ""}">自主單字</button>
        </div>
      </div>
      <div class="field">
        <label>發音／音標（選填）</label>
        <input type="text" name="pronunciation" value="${node ? escapeAttr(node.pronunciation || "") : ""}" />
      </div>
      <div class="field">
        <label>詞性、翻譯與例句 *</label>
        ${renderSensesList(senses)}
      </div>
      <div class="field">
        <label>同義字（選填）</label>
        ${renderSynonymsField(editorSynonyms)}
      </div>
      <div class="field">
        <label>我的補充（選填）</label>
        <textarea name="supplement_note" rows="3" placeholder="老師額外說明、自己的理解、容易搞混的地方……">${node ? escapeAttr(node.supplement_note || "") : ""}</textarea>
      </div>
      <div class="field">
        <label>來源（選填）</label>
        <input type="text" name="source_note" value="${node ? escapeAttr(node.source_note || "") : ""}" placeholder="這個字是從哪裡遇到的？" />
      </div>
    `;
  }
  if (type === "phrase") {
    // 片語整體就是一個詞性單位（例如 "give up" 整體是動詞片語），
    // 所以是單選下拉選單，不像單字的詞性是每個意思各自一個。
    return `
      <div class="field">
        <label>片語 *</label>
        <input type="text" name="headword" value="${node ? escapeAttr(node.headword) : ""}" placeholder="輸入英文原文……" />
      </div>
      <div class="field">
        <label>詞性（選填）</label>
        <select name="phrase_type">
          <option value="">不分類</option>
          ${PHRASE_TYPES.map(
            (t) => `<option value="${t.value}" ${node?.phrase_type === t.value ? "selected" : ""}>${t.label}</option>`
          ).join("")}
        </select>
      </div>
      <div class="field">
        <label>中文翻譯 / 解釋 *</label>
        <textarea name="translation" rows="2" placeholder="這個片語的意思……">${node ? escapeAttr(node.translation) : ""}</textarea>
      </div>
      <div class="field">
        <label>例句（選填）</label>
        <textarea name="examples" rows="3" placeholder="這個片語的例句，一行一句……">${node ? escapeAttr(node.examples || "") : ""}</textarea>
      </div>
      <div class="field">
        <label>我的補充（選填）</label>
        <textarea name="supplement_note" rows="3" placeholder="老師額外說明、自己的理解、容易搞混的地方……">${node ? escapeAttr(node.supplement_note || "") : ""}</textarea>
      </div>
      <div class="field">
        <label>來源（選填）</label>
        <input type="text" name="source_note" value="${node ? escapeAttr(node.source_note || "") : ""}" placeholder="這個片語是從哪裡遇到的？" />
      </div>
    `;
  }
  if (type === "grammar") {
    return `
      <div class="field">
        <label>文法標題 *</label>
        <input type="text" name="headword" value="${node ? escapeAttr(node.headword) : ""}" placeholder="例如：現在完成式、被動語態" />
      </div>
      <div class="field">
        <label>核心公式（選填）</label>
        <input type="text" name="pattern" value="${node ? escapeAttr(node.pattern || "") : ""}" placeholder="例如：S + have/has + p.p." />
      </div>
      <div class="field">
        <label>用法說明 *</label>
        <textarea name="supplement_note" rows="4" placeholder="這條規則強調的意思、什麼時候用……例如：強調過去發生的動作對現在造成的影響/結果">${node ? escapeAttr(node.supplement_note || "") : ""}</textarea>
      </div>
      <div class="field">
        <label>觸發關鍵字（選填）</label>
        <input type="text" name="signal_words" value="${node ? escapeAttr(node.signal_words || "") : ""}" placeholder="例如：already, yet, ever, for, since" />
      </div>
      <div class="field">
        <label>核心例句與解析（選填）</label>
        <textarea name="examples" rows="4" placeholder="正確例句，一行一句；也可以換行補充說明……例如：I have already finished my homework.">${node ? escapeAttr(node.examples || "") : ""}</textarea>
      </div>
      <div class="field">
        <label>常見錯誤 / 易混淆對比（選填）</label>
        <textarea name="caution_note" rows="3" placeholder="例如：❌ I have finished my homework yesterday.（過去時間點 yesterday 不能搭配現在完成式，需用過去簡單式）">${node ? escapeAttr(node.caution_note || "") : ""}</textarea>
      </div>
      <div class="field">
        <label>文法標籤（選填）</label>
        <select name="grammar_category">
          <option value="">不分類</option>
          ${GRAMMAR_CATEGORIES.map(
            (c) => `<option value="${c.value}" ${node?.grammar_category === c.value ? "selected" : ""}>${c.label}</option>`
          ).join("")}
        </select>
      </div>
    `;
  }
}

function readSensesFromDom() {
  return [...editorModal.querySelectorAll("#senses-wrap .sense-block")].map((block) => ({
    part_of_speech: block.querySelector(".sense-pos").value,
    translation: block.querySelector(".sense-translation").value,
    example: block.querySelector(".sense-example").value,
  }));
}

function wireSensesWrap() {
  const wrap = editorModal.querySelector("#senses-wrap");
  if (!wrap) return;
  wrap.querySelectorAll("[data-remove-sense]").forEach((btn) => {
    btn.onclick = () => {
      editorSenses = readSensesFromDom();
      editorSenses.splice(Number(btn.dataset.removeSense), 1);
      wrap.outerHTML = renderSensesList(editorSenses);
      wireSensesWrap();
    };
  });
  wrap.querySelector("#add-sense-btn").onclick = () => {
    editorSenses = readSensesFromDom();
    editorSenses.push({ part_of_speech: "", translation: "", example: "" });
    wrap.outerHTML = renderSensesList(editorSenses);
    wireSensesWrap();
  };
}

// 找到完全同名的既有單字時，暫時把整個編輯視窗換成這個選擇畫面，而不是
// 默默建立一個重複的單字，也不會自己猜測、自動合併——三個選項都是使用者
// 自己決定，「還是要新增一個新的」是保守起見留的退路。
function showDuplicateWarning(existing, { doCreate, isSelfStudy }) {
  const actions = [];
  if (editorCourseId) {
    actions.push({ key: "link-course", label: "＋ 加入這堂課", primary: true });
  } else if (isSelfStudy) {
    actions.push({ key: "mark-self", label: "標記為自主單字來源", primary: true });
  }
  actions.push({ key: "view", label: "查看既有單字" });
  actions.push({ key: "create-anyway", label: "還是要新增一個新的" });

  editorModal.innerHTML = `
    <h2>已經有「${escapeHtml(existing.headword)}」了</h2>
    <p class="hint" style="margin-bottom:16px;">避免建立重複的單字——可以把這次的來源併入既有的那一個，或確認這真的是不同的字。</p>
    <div class="modal-footer" style="flex-direction:column; align-items:stretch; gap:8px;">
      ${actions.map((a) => `<button type="button" class="btn ${a.primary ? "btn-accent" : ""}" data-dup-action="${a.key}">${a.label}</button>`).join("")}
    </div>
  `;
  editorModal.querySelector('[data-dup-action="link-course"]')?.addEventListener("click", async () => {
    await db.linkNodeToCourse(existing.id, editorCourseId);
    closeEditorModal();
    toast(`已把「${existing.headword}」加入這堂課`);
    refreshApp();
  });
  editorModal.querySelector('[data-dup-action="mark-self"]')?.addEventListener("click", async () => {
    if (!existing.is_self_study) await db.updateNode(existing.id, { is_self_study: true });
    closeEditorModal();
    openDetailPanel(existing.id);
    toast("已標記為自主單字來源");
  });
  editorModal.querySelector('[data-dup-action="view"]').onclick = () => {
    closeEditorModal();
    openDetailPanel(existing.id);
  };
  editorModal.querySelector('[data-dup-action="create-anyway"]').onclick = () => {
    doCreate();
  };
}

function wireWordSourceToggle() {
  const toggle = editorModal.querySelector("#word-source-toggle");
  if (!toggle) return;
  toggle.querySelectorAll("button").forEach((btn) => {
    btn.onclick = () => {
      toggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    };
  });
}

function wireEditor(mode, node, fromNode) {
  const form = editorModal.querySelector("#editor-form");
  editorModal.querySelector("#editor-cancel").onclick = closeEditorModal;

  const typeToggle = editorModal.querySelector("#type-toggle");
  const nodeFields = editorModal.querySelector("#node-fields");
  if (typeToggle) {
    typeToggle.querySelectorAll("button").forEach((btn) => {
      btn.onclick = () => {
        typeToggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        if (btn.dataset.type === "word") {
          editorSenses = initialSenses(node);
          editorSynonyms = node?.synonyms ? [...node.synonyms] : [];
        }
        nodeFields.innerHTML = renderNodeFields(btn.dataset.type, node, editorSenses);
        wireSensesWrap();
        wireSynonymsWrap();
        wireWordSourceToggle();
      };
    });
  }
  wireSensesWrap();
  wireSynonymsWrap();
  wireWordSourceToggle();

  const searchInput = editorModal.querySelector("#relation-search");
  const suggestBox = editorModal.querySelector("#suggest-box");
  const slot = editorModal.querySelector("#pending-relation-slot");

  if (searchInput) {
    let debounce;
    searchInput.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(async () => {
        const q = searchInput.value.trim();
        if (!q) {
          suggestBox.innerHTML = `<div class="suggest-empty">開始輸入以搜尋既有內容</div>`;
          return;
        }
        const results = (await db.searchNodes(q)).filter((n) => n.id !== node?.id && n.id !== fromNode?.id).slice(0, 8);
        suggestBox.innerHTML =
          results
            .map(
              (n) => `<div class="suggest-item" data-pick="${n.id}" data-headword="${escapeAttr(n.headword)}">
                <span class="type-badge type-${n.type}">${typeLabel(n.type)}</span>
                <span>${escapeHtml(n.headword)}</span>
                <span class="hint">${escapeHtml((n.type === "grammar" ? grammarPreviewText(n) : n.translation) || "")}</span>
              </div>`
            )
            .join("") || `<div class="suggest-empty">沒有符合的內容</div>`;
        suggestBox.querySelectorAll("[data-pick]").forEach((item) => {
          item.onclick = () => {
            pendingRelation = { toNodeId: item.dataset.pick, headword: item.dataset.headword, relation_type: "synonym", note: "" };
            renderPendingSlot(slot);
            searchInput.value = "";
            suggestBox.innerHTML = `<div class="suggest-empty">開始輸入以搜尋既有內容</div>`;
          };
        });
      }, 150);
    });
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);

    try {
      if (mode === "relation-only") {
        if (!pendingRelation) {
          toast("請先選擇要連結的內容");
          return;
        }
        await db.createEdge({
          from_node_id: fromNode.id,
          to_node_id: pendingRelation.toNodeId,
          relation_type: pendingRelation.relation_type,
          note: pendingRelation.note,
        });
        closeEditorModal();
        openDetailPanel(fromNode.id);
        toast("已新增關聯");
        return;
      }

      const currentType = mode === "edit" ? node.type : typeToggle?.querySelector("button.active")?.dataset.type || "word";
      const isGrammar = currentType === "grammar";
      // 只有單字需要分詞性——片語不同詞性硬要分開列反而瑣碎，只用一個翻譯欄位。
      const usesSenses = currentType === "word";
      const senses = usesSenses ? readSensesFromDom().filter((s) => s.translation.trim()) : [];
      const isSelfStudy = usesSenses
        ? (editorModal.querySelector("#word-source-toggle button.active")?.dataset.source || "self") === "self"
        : false;
      // 使用者打了同義字但忘記按 Enter／點新增就直接送出表單——存檔前先把
      // 輸入框裡還沒變成標籤的文字也收進去，不要悄悄弄丟。
      if (usesSenses) {
        const pendingSynonym = editorModal.querySelector("#synonym-input")?.value.trim();
        if (pendingSynonym && !editorSynonyms.some((s) => s.toLowerCase() === pendingSynonym.toLowerCase())) {
          editorSynonyms.push(pendingSynonym);
        }
      }

      if (mode === "edit" || mode === "create") {
        if (!fd.get("headword")?.trim()) {
          toast(isGrammar ? "請填寫文法標題" : `請填寫${typeLabel(currentType)}`);
          editorModal.querySelector('[name="headword"]')?.focus();
          return;
        }
        if (usesSenses && senses.length === 0) {
          toast("請至少填寫一組詞性與翻譯");
          editorModal.querySelector(".sense-translation")?.focus();
          return;
        }
        if (!isGrammar && !usesSenses && !fd.get("translation")?.trim()) {
          toast("請填寫翻譯");
          editorModal.querySelector('[name="translation"]')?.focus();
          return;
        }
        if (isGrammar && !fd.get("supplement_note")?.trim()) {
          toast("請填寫核心說明");
          editorModal.querySelector('[name="supplement_note"]')?.focus();
          return;
        }
      }

      if (mode === "edit") {
        // 每種類型看到的欄位不一樣，patch 只能放表單上真的有出現的欄位——
        // 否則沒出現的欄位會被 fd.get() 讀成 null，把舊資料覆蓋掉。
        const patch = {
          headword: fd.get("headword"),
          supplement_note: fd.get("supplement_note"),
          // 例句是單字／片語／文法共用的欄位，可以統一放在最上面。
          examples: fd.get("examples"),
        };
        if (isGrammar) {
          patch.pattern = fd.get("pattern") || null;
          patch.grammar_category = fd.get("grammar_category") || null;
          patch.signal_words = fd.get("signal_words");
          patch.caution_note = fd.get("caution_note");
        } else if (currentType === "phrase") {
          patch.translation = fd.get("translation");
          patch.phrase_type = fd.get("phrase_type") || null;
          patch.source_note = fd.get("source_note");
        } else if (usesSenses) {
          patch.senses = senses;
          patch.translation = db.joinSenses(senses);
          patch.part_of_speech = null; // 已被 senses 取代
          patch.pronunciation = fd.get("pronunciation");
          patch.source_note = fd.get("source_note");
          patch.is_self_study = isSelfStudy;
          patch.synonyms = db.cleanSynonyms(editorSynonyms);
        }
        await db.updateNode(node.id, patch);
        closeEditorModal();
        openDetailPanel(node.id);
        toast("已儲存變更");
        refreshApp();
        return;
      }

      const doCreate = async () => {
        const newNode = await db.createNode({
          type: currentType,
          headword: fd.get("headword"),
          translation: fd.get("translation"),
          pronunciation: fd.get("pronunciation"),
          part_of_speech: usesSenses ? null : fd.get("part_of_speech"),
          senses: usesSenses ? senses : undefined,
          synonyms: usesSenses ? editorSynonyms : undefined,
          supplement_note: fd.get("supplement_note"),
          source_note: fd.get("source_note"),
          pattern: isGrammar ? fd.get("pattern") || null : null,
          grammar_category: isGrammar ? fd.get("grammar_category") || null : null,
          phrase_type: currentType === "phrase" ? fd.get("phrase_type") || null : null,
          examples: fd.get("examples"),
          signal_words: isGrammar ? fd.get("signal_words") : null,
          caution_note: isGrammar ? fd.get("caution_note") : null,
          is_self_study: isSelfStudy,
        });
        if (pendingRelation) {
          await db.createEdge({
            from_node_id: newNode.id,
            to_node_id: pendingRelation.toNodeId,
            relation_type: pendingRelation.relation_type,
            note: pendingRelation.note,
          });
        }
        if (editorCourseId) {
          await db.linkNodeToCourse(newNode.id, editorCourseId);
        }
        closeEditorModal();
        refreshApp();
        toast(pendingRelation ? "已新增內容與關聯" : "已新增內容（尚未建立關聯）");
      };

      // 避免重複建立同一個單字（例如自主單字之後又在家教課教到同一個字）——
      // 只在「新增單字」時檢查，只做完全比對，找到才會打斷正常流程。
      if (mode === "create" && usesSenses) {
        const existing = await db.findWordByHeadword(fd.get("headword"));
        if (existing) {
          showDuplicateWarning(existing, { doCreate, isSelfStudy });
          return;
        }
      }

      await doCreate();
    } catch (err) {
      toast(err.message || "發生錯誤");
    }
  };
}

function renderPendingSlot(slot) {
  if (!pendingRelation) {
    slot.innerHTML = "";
    return;
  }
  slot.innerHTML = `
    <div class="relation-pending">
      <span>連結到 <strong>${escapeHtml(pendingRelation.headword)}</strong></span>
      <select id="pending-relation-type">
        ${RELATION_TYPES.map((r) => `<option value="${r.value}">${r.label}</option>`).join("")}
      </select>
      <button type="button" data-clear-pending>✕</button>
    </div>
    <div class="field" style="margin-top:8px;">
      <textarea id="pending-relation-note" placeholder="為什麼把這兩個內容連在一起？（選填）"></textarea>
    </div>
  `;
  slot.querySelector("#pending-relation-type").onchange = (e) => {
    pendingRelation.relation_type = e.target.value;
  };
  slot.querySelector("#pending-relation-note").oninput = (e) => {
    pendingRelation.note = e.target.value;
  };
  slot.querySelector("[data-clear-pending]").onclick = () => {
    pendingRelation = null;
    renderPendingSlot(slot);
  };
}

/* ============================================================ */

export function toast(message) {
  const t = document.getElementById("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2200);
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) {
  return escapeHtml(str);
}
