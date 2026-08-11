import * as db from "./db.js";
import { openEditorModal, openDetailPanel, toast, triggerRefresh } from "./panels.js";
import { typeLabel, grammarPreviewText, wordRowMeta } from "./constants.js";
import {
  renderNotesContent,
  sanitizeHtml,
  applyInlineStyle,
  clearInlineStyle,
  getSelectionClassWithPrefix,
  escapeEmptyStyleSpanAtCursor,
  wrapStrayText,
  COLORS,
  SIZE_LEVELS,
} from "./markdown.js";

const COLOR_LABELS = { red: "紅", orange: "橘", green: "綠", blue: "藍", purple: "紫" };

// 用 SVG 圖示取代 👤 emoji——emoji 在不同系統/字體裡的繪製位置不一致，
// 常常沒辦法用 CSS 完全對齊到旁邊文字的中線；SVG 是我們自己畫的向量圖，
// 大小跟置中都能精準控制，不會有這個問題。
const TEACHER_ICON_SVG = `<svg class="course-list-teacher-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"></circle><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"></path></svg>`;

// Object URLs created for attachment previews/downloads — revoked and
// rebuilt on every page render so they don't leak across re-renders.
let attachmentObjectUrls = [];
function revokeAttachmentUrls() {
  attachmentObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  attachmentObjectUrls = [];
}
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ============================================================
   課程列表 — Stage 04 導覽目的地
   ============================================================ */

let courseQuery = "";

export async function renderCourseList(container) {
  const courses = await db.listCourses();
  const counts = await Promise.all(courses.map((c) => db.getCourseLinksForCourse(c.id)));

  container.innerHTML = `
    <div class="list-wrap">
      <div class="list-controls">
        <input type="text" id="course-search" placeholder="搜尋標題／關鍵字／內容…" value="${escapeAttr(courseQuery)}" />
        <button class="btn btn-accent" id="add-course-btn">＋ 新增課程</button>
      </div>
      <div class="list-result-count" id="course-result-count"></div>
      <div id="course-results"></div>
    </div>
  `;
  container.querySelector("#add-course-btn").onclick = async () => {
    const course = await db.createCourse({ date: db.todayStr(), title: "", content: "" });
    location.hash = `#/course?id=${course.id}`;
  };
  container.querySelector("#course-search").oninput = (e) => {
    courseQuery = e.target.value;
    paintCourseResults(container, courses, counts);
  };

  paintCourseResults(container, courses, counts);
}

function paintCourseResults(container, courses, counts) {
  const results = container.querySelector("#course-results");
  const countEl = container.querySelector("#course-result-count");

  if (courses.length === 0) {
    countEl.textContent = "";
    results.innerHTML = `<div class="empty-state">還沒有課程記錄——上完課後點「＋新增課程」開始記錄。</div>`;
    return;
  }

  const q = courseQuery.trim().toLowerCase();
  const rows = courses
    .map((c, i) => ({ c, count: counts[i].length }))
    .filter(({ c }) => {
      if (!q) return true;
      return (
        (c.title || "").toLowerCase().includes(q) ||
        (c.keywords || "").toLowerCase().includes(q) ||
        (c.content || "").toLowerCase().includes(q)
      );
    });

  countEl.textContent = q ? `顯示 ${rows.length} 筆` : "";

  if (rows.length === 0) {
    results.innerHTML = `<div class="empty-state">找不到符合的課程。</div>`;
    return;
  }

  results.innerHTML = rows
    .map(
      ({ c, count }) => `
      <div class="node-row" data-open-course="${c.id}">
        <span class="type-badge type-word">${escapeHtml(c.date || "")}</span>
        <strong class="headword">${escapeHtml(c.title || "未命名課程")}</strong>
        ${c.keywords ? `<span class="course-keywords-chip">🔑 ${escapeHtml(c.keywords)}</span>` : ""}
        <span class="course-list-meta" style="margin-left:auto;">
          ${
            c.teacher
              ? `<span class="course-list-teacher">${TEACHER_ICON_SVG}<span class="course-list-teacher-name">${escapeHtml(c.teacher)}</span></span><span class="course-list-meta-sep">·</span>`
              : ""
          }
          <span class="edge-count">${count} 個單字</span>
        </span>
      </div>`
    )
    .join("");
  results.querySelectorAll("[data-open-course]").forEach((row) => {
    row.onclick = () => {
      location.hash = `#/course?id=${row.dataset.openCourse}`;
    };
  });
}

/* ============================================================
   課程學習頁 — 導覽子頁面（v0.3：從覆蓋層改版而來，見 PRD 04.2）
   ============================================================ */

export async function renderCourseLearningPage(container, courseId) {
  const course = await db.getCourse(courseId);
  if (!course) {
    container.innerHTML = `<div class="empty-state">找不到這堂課，可能已經被刪除。<br><a href="#/courses">回到課程列表</a></div>`;
    return;
  }
  const links = await db.getCourseLinksForCourse(courseId);
  const words = (await Promise.all(links.map(async (link) => ({ link, node: await db.getNode(link.node_id) })))).filter(
    (w) => w.node
  );
  const attachments = await db.getAttachmentsForCourse(courseId);

  revokeAttachmentUrls();
  container.innerHTML = renderPage(course, words, attachments);
  wirePage(container, course, words);
}

function renderPage(course, words, attachments) {
  const wordsHtml = words.length
    ? `<div class="related-list course-words-list">
        ${words
          .map(({ link, node }) => {
            const { pos, translation } = wordRowMeta(node);
            return `<div class="related-item course-word-row" data-jump-word="${node.id}">
              <span class="type-badge type-${node.type}">${typeLabel(node.type)}</span>
              <strong class="course-word-headword">${escapeHtml(node.headword)}</strong>
              <span class="course-word-pos">${escapeHtml(pos)}</span>
              <span class="course-word-translation">${escapeHtml(translation)}</span>
              <button class="btn btn-sm btn-ghost course-word-delete" data-unlink="${link.id}" title="移除這個字跟這堂課的連結">✕</button>
            </div>`;
          })
          .join("")}
      </div>`
    : `<p class="hint">這堂課還沒有記錄任何單字。</p>`;

  const notesHtml = renderNotesContent(course.content) || `<p class="hint">（尚未填寫，點「編輯筆記」開始寫）</p>`;

  const attachmentsHtml = attachments.length
    ? `<div class="attachment-list">
        ${attachments
          .map((att) => {
            const url = URL.createObjectURL(att.blob);
            attachmentObjectUrls.push(url);
            const isImage = att.mime_type.startsWith("image/");
            const isAudio = att.mime_type.startsWith("audio/");
            const preview = isImage
              ? `<img src="${url}" class="attachment-thumb" alt="${escapeAttr(att.filename)}" />`
              : isAudio
              ? `<audio controls src="${url}" class="attachment-audio"></audio>`
              : `<span class="attachment-icon">📄</span>`;
            return `<div class="attachment-item">
              ${preview}
              <div class="attachment-info">
                <a href="${url}" download="${escapeAttr(att.filename)}" class="attachment-name">${escapeHtml(att.filename)}</a>
                <span class="attachment-size">${formatFileSize(att.size)}</span>
              </div>
              <button type="button" class="btn btn-sm btn-ghost" data-delete-attachment="${att.id}" title="刪除附件">✕</button>
            </div>`;
          })
          .join("")}
      </div>`
    : `<p class="hint">還沒有上傳任何附件。</p>`;

  return `
    <div class="course-page">
      <a class="course-back" href="#/courses">← 回到課程列表</a>

      <div class="course-header">
        <div class="course-header-row">
          <input type="date" class="course-date-input" id="course-date-input" value="${course.date || ""}" />
          <input type="text" class="course-title-input" id="course-title-input" placeholder="未命名課程" value="${escapeAttr(course.title || "")}" />
        </div>
        <div class="course-teacher-row">
          <span class="course-teacher-label">👤 授課老師</span>
          <input type="text" class="course-teacher-input" id="course-teacher-input" placeholder="（選填）" value="${escapeAttr(course.teacher || "")}" />
        </div>
        <div class="course-teacher-row">
          <span class="course-teacher-label">🔑 關鍵字</span>
          <input type="text" class="course-keywords-input" id="course-keywords-input" placeholder="方便之後快速搜尋，例如：文法、過去式（選填）" value="${escapeAttr(course.keywords || "")}" autocomplete="off" autocorrect="off" spellcheck="false" />
        </div>
      </div>

      <section class="course-section">
        <div class="course-section-head">
          <h3>本堂課單字（${words.length}）</h3>
          <div style="display:flex; gap:8px;">
            ${words.length ? `<button class="btn btn-sm" data-review-course>🔄 複習本課單字</button>` : ""}
            <button class="btn btn-accent btn-sm" data-add-word>＋ 新增單字</button>
          </div>
        </div>
        ${wordsHtml}

        <div class="course-link-row">
          <input type="text" id="course-word-search" class="course-link-search" placeholder="🔎 連結既有單字：輸入 headword 或翻譯搜尋（已記錄過的字不用重建）…" autocomplete="off" />
        </div>
        <div class="suggest-box" id="course-word-suggest" hidden>
          <div class="suggest-empty">開始輸入以搜尋既有內容</div>
        </div>
      </section>

      <section class="course-section">
        <div class="course-section-head">
          <h3>課堂筆記</h3>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-sm" data-mark-pending>🕓 新增待處理問題</button>
            <button class="btn btn-accent btn-sm" data-toggle-edit-notes>✏️ 編輯筆記</button>
          </div>
        </div>
        <div class="course-notes-display markdown-content">${notesHtml}</div>
        <div class="course-notes-editor" hidden>
          <div class="notes-editor-frame">
            <div class="notes-editor-toolbar md-toolbar">
              <button type="button" data-md="ul" title="條列">• 條列</button>
              <button type="button" data-md="ol" title="編號">1. 編號</button>
              <button type="button" data-md="quote" title="引用老師的話">❝ 引用</button>
              <span class="md-toolbar-divider"></span>
              <button type="button" data-bold title="粗體"><strong>B</strong></button>
              <button type="button" data-underline title="底線"><u>U</u></button>
              <span class="md-toolbar-divider"></span>
              <span class="md-toolbar-label">顏色</span>
              ${COLORS.map(
                (c) => `<button type="button" class="md-swatch" data-color="${c}" style="--swatch-color:var(--hl-${c})" title="${COLOR_LABELS[c]}"></button>`
              ).join("")}
              <span class="md-toolbar-label">字級</span>
              <button type="button" data-size-step="1" title="放大一級（可以連續點，一直變大）">A+</button>
              <button type="button" data-size-step="-1" title="縮小一級">A-</button>
              <span class="md-toolbar-divider"></span>
              <button type="button" data-clear title="清除格式（還原成預設黑字／字級）">🧹 清除格式</button>
            </div>
            <div
              id="course-notes-editable"
              class="notes-editable markdown-content"
              contenteditable="true"
              data-placeholder="自由書寫這堂課的筆記……選取文字後可套用顏色／字級；工具列可以加條列、編號、引用老師的話。"
            ></div>
            <div class="course-notes-actions">
              <button type="button" class="btn" data-cancel-notes>取消</button>
              <button type="button" class="btn btn-accent" data-save-notes>儲存筆記</button>
            </div>
          </div>
        </div>
      </section>

      <section class="course-section">
        <h3>課堂錄影</h3>
        <div class="course-video-row">
          <input type="text" id="course-video-input" placeholder="貼上 YouTube／Google Drive 或其他影片連結" value="${escapeAttr(course.video_url || "")}" />
          <button type="button" class="btn btn-accent" id="course-video-open" ${course.video_url ? "" : "disabled"}>▶ 開啟課堂錄影</button>
        </div>
      </section>

      <section class="course-section">
        <div class="course-section-head">
          <h3>附件</h3>
          <button type="button" class="btn btn-sm" data-upload-attachment>📎 上傳附件</button>
          <input type="file" id="course-attachment-input" hidden multiple />
        </div>
        <p class="hint" style="margin-top:-4px;margin-bottom:10px;">講義、圖片、上課錄音檔都可以——存在這台裝置的瀏覽器裡，記得定期用「匯出備份」保留一份。</p>
        ${attachmentsHtml}
      </section>

      <div class="course-danger">
        <button class="btn btn-danger btn-sm" data-delete-course>刪除課程</button>
      </div>
    </div>
  `;
}

function wirePage(container, course, words) {
  const page = container.querySelector(".course-page");

  const dateInput = page.querySelector("#course-date-input");
  dateInput.addEventListener("change", async () => {
    await db.updateCourse(course.id, { date: dateInput.value });
    course.date = dateInput.value;
  });

  const titleInput = page.querySelector("#course-title-input");
  titleInput.addEventListener("blur", async () => {
    if (titleInput.value === course.title) return;
    await db.updateCourse(course.id, { title: titleInput.value });
    course.title = titleInput.value;
  });
  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) titleInput.blur();
  });

  const teacherInput = page.querySelector("#course-teacher-input");
  teacherInput.addEventListener("blur", async () => {
    const value = teacherInput.value.trim();
    if (value === (course.teacher || "")) return;
    await db.updateCourse(course.id, { teacher: value || null });
    course.teacher = value || null;
  });
  teacherInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) teacherInput.blur();
  });

  const keywordsInput = page.querySelector("#course-keywords-input");
  keywordsInput.addEventListener("blur", async () => {
    const value = keywordsInput.value.trim();
    if (value === (course.keywords || "")) return;
    await db.updateCourse(course.id, { keywords: value || null });
    course.keywords = value || null;
  });
  keywordsInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) keywordsInput.blur();
  });

  const videoInput = page.querySelector("#course-video-input");
  const videoOpenBtn = page.querySelector("#course-video-open");
  videoInput.addEventListener("input", () => {
    videoOpenBtn.disabled = !videoInput.value.trim();
  });
  videoInput.addEventListener("blur", async () => {
    const value = videoInput.value.trim();
    if (value === (course.video_url || "")) return;
    await db.updateCourse(course.id, { video_url: value || null });
    course.video_url = value || null;
  });
  videoOpenBtn.onclick = () => {
    const url = videoInput.value.trim();
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  const notesDisplay = page.querySelector(".course-notes-display");
  const notesEditor = page.querySelector(".course-notes-editor");
  const notesEditable = page.querySelector("#course-notes-editable");
  const toggleEditNotesBtn = page.querySelector("[data-toggle-edit-notes]");

  // 點工具列按鈕時，瀏覽器預設會先讓 contenteditable 失焦，選取範圍會不見，
  // 套用顏色／字級就會抓不到「選了什麼」。在 mousedown 階段擋掉，選取範圍
  // 才會一路保留到 click handler 真的執行套用的時候。
  page.querySelector(".notes-editor-toolbar").addEventListener("mousedown", (e) => e.preventDefault());

  // 讓 contenteditable 按 Enter 換行時產生 <p>，不是各瀏覽器預設不一致的
  // <div>——這樣存下來的結構才會跟 sanitizeHtml／.markdown-content 的樣式
  // 假設一致。這個 API 雖然標示為過時，但目前主要瀏覽器都還支援，是最
  // 輕量、不需要額外套件就能控制這個行為的方法。
  try {
    document.execCommand("defaultParagraphSeparator", false, "p");
  } catch {}

  // 換行後「打的第一個字」如果被瀏覽器自己包上顏色/字級，馬上偵測到就
  // 拆掉——見下面的 input 監聽器。這個旗標只用來標記「剛換行，接下來
  // 這一次輸入要檢查」，檢查完（不管有沒有拆到東西）就重設，不會影響
  // 使用者之後自己點顏色/字級按鈕、正常輸入的內容。
  let justPressedEnter = false;

  // 換行（Enter）完全自己手動處理，不透過瀏覽器的 execCommand。
  // 前幾輪都是「先讓瀏覽器用它自己的方式換行，再事後清理殘留的顏色/字
  // 級」，但瀏覽器內部會另外記住一份「目前打字要用的格式」，這份記憶
  // 獨立於 DOM 結構之外——連換到一個全新、從沒被瀏覽器碰過的 <p> 都還是
  // 會繼承，證明這不是「哪個標籤沒清乾淨」的問題，而是瀏覽器自己在背
  // 後記著、不受我們建立的容器影響。與其繼續猜「怎麼預防」，改成「打完
  // 第一個字，馬上檢查、馬上拆」，見下面 input 監聽器。
  notesEditable.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    e.preventDefault();

    const range = sel.getRangeAt(0);
    if (!range.collapsed) range.deleteContents();

    let block = range.startContainer;
    if (block.nodeType === 3) block = block.parentNode;
    while (block && block !== notesEditable && !["P", "LI", "H2", "H3", "BLOCKQUOTE"].includes(block.tagName)) {
      block = block.parentNode;
    }
    if (!block || block === notesEditable) return;

    // 把游標之後（同一個區塊內剩下）的內容切出來，放進新段落——這樣在一
    // 行的「中間」按 Enter，後半段文字會正確被搬到新的一行，不會憑空消失。
    const afterRange = document.createRange();
    afterRange.setStart(range.startContainer, range.startOffset);
    afterRange.setEndAfter(block.lastChild || block);
    const movedContent = afterRange.extractContents();

    const newBlock = document.createElement("p");
    if (movedContent.textContent) newBlock.appendChild(movedContent);
    else newBlock.appendChild(document.createElement("br"));

    const list = block.tagName === "LI" ? block.closest("ul, ol") : null;
    if (list) {
      // 退出清單：新段落插在整個清單外面，不是清單裡的下一項。
      list.parentNode.insertBefore(newBlock, list.nextSibling);
      // 原本那一項如果被搬空了（游標本來就在項目最前面），而且清單裡
      // 還有其他項目，把這個空項目移除；如果它是清單唯一的項目，保留
      // 它，不然整個清單會憑空消失。
      if (block.textContent === "" && list.children.length > 1) block.remove();
    } else {
      block.parentNode.insertBefore(newBlock, block.nextSibling);
    }

    const newRange = document.createRange();
    newRange.setStart(newBlock, 0);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);

    justPressedEnter = true;
  });

  // 換行後打的第一個字，如果瀏覽器自己把它包上了顏色/字級（不管是用哪種
  // 標籤或屬性），這裡直接抓「游標當下實際所在」的標籤往上拆，拆到遇到
  // 沒有樣式的節點為止——不用事先猜是哪一種標籤/屬性，反正只要有樣式就
  // 拆。只在換行後的第一次輸入做這件事，之後（使用者自己點顏色/字級按
  // 鈕套用的）都不會被這裡動到。
  notesEditable.addEventListener("input", () => {
    if (!justPressedEnter) return;
    justPressedEnter = false;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === 3) node = node.parentNode;

    while (node && node !== notesEditable && (node.tagName === "SPAN" || node.tagName === "FONT")) {
      const hasStyleClass = (node.getAttribute("class") || "").split(/\s+/).some((c) => c.startsWith("hl-") || c.startsWith("fs-"));
      const hasInlineStyle = node.hasAttribute("style") || node.hasAttribute("color") || node.hasAttribute("size");
      if (!hasStyleClass && !hasInlineStyle) break;
      const parent = node.parentNode;
      if (!parent) break;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      parent.removeChild(node);
      node = parent;
    }
  });

  toggleEditNotesBtn.onclick = () => {
    // 完全空的 contenteditable（連一個子節點都沒有）在 Safari 上常常不會
    // 顯示閃爍游標，點進去也不知道要打在哪——放一個空的 <p></p> 撐著，
    // 游標就能正常定位／顯示；是否顯示「請開始輸入」的提示文字改用
    // CSS :has() 判斷（見 styles.css），不再依賴真正的 :empty。
    notesEditable.innerHTML = renderNotesContent(course.content) || "<p></p>";
    wrapStrayText(notesEditable); // 修正舊資料可能殘留的「裸文字沒包在 <p> 裡」問題
    notesDisplay.hidden = true;
    notesEditor.hidden = false;
    toggleEditNotesBtn.hidden = true;
    notesEditable.focus();
  };
  page.querySelector("[data-cancel-notes]").onclick = () => {
    notesEditor.hidden = true;
    notesDisplay.hidden = false;
    toggleEditNotesBtn.hidden = false;
  };
  page.querySelector("[data-save-notes]").onclick = async () => {
    // 存檔前先確保沒有裸露在區塊元素外面的文字（見 wrapStrayText 註解），
    // 不然存下去的 HTML 開頭可能是文字不是標籤，下次顯示會被誤判成舊格式
    // 逐字顯示出來（畫面上出現一堆 <p></p> 這種原始標籤文字）。
    wrapStrayText(notesEditable);
    // 只有空殼 <p></p>（使用者根本沒打字）時視為沒有內容，不要把這個空殼
    // 存進資料庫——不然下次顯示會誤判成「已經有內容」。
    const isEmpty = notesEditable.textContent.trim() === "";
    const html = isEmpty ? "" : sanitizeHtml(notesEditable.innerHTML);
    const value = html || null;
    await db.updateCourse(course.id, { content: value });
    course.content = value;
    notesDisplay.innerHTML = html || `<p class="hint">（尚未填寫，點「編輯筆記」開始寫）</p>`;
    notesEditor.hidden = true;
    notesDisplay.hidden = false;
    toggleEditNotesBtn.hidden = false;
    toast("已儲存筆記");
  };
  page.querySelectorAll("[data-md]").forEach((btn) => {
    btn.onclick = () => {
      notesEditable.focus();
      // 條列/編號/引用開始前，先把選取範圍內殘留的顏色／字級樣式清乾淨。
      // 套色/放大字級後那段文字會維持選取狀態（方便連續疊加顏色+字級），
      // 如果使用者接著點條列，沒清乾淨的話色/字級會被一起帶進清單項目，
      // 變成「條列文字自動變色變大」。選取範圍是空的（只是游標）時，改
      // 檢查游標有沒有卡在殘留的空樣式殼裡。
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) clearInlineStyle(notesEditable);
      else escapeEmptyStyleSpanAtCursor(notesEditable);
      switch (btn.dataset.md) {
        case "ul":
          document.execCommand("insertUnorderedList");
          break;
        case "ol":
          document.execCommand("insertOrderedList");
          break;
        case "quote":
          document.execCommand("formatBlock", false, "blockquote");
          break;
      }
    };
  });
  page.querySelectorAll("[data-color]").forEach((btn) => {
    btn.onclick = () => {
      notesEditable.focus();
      if (!applyInlineStyle(notesEditable, "color", `hl-${btn.dataset.color}`)) toast("請先選取要套用顏色的文字");
    };
  });
  // 字級是階梯式的（見 SIZE_LEVELS）：每點一次 A+/A- 都是從「目前選取範圍
  // 的字級」往上或往下走一格，不是固定套用同一個大小——這樣才能連續點好
  // 幾次持續放大／縮小，而不是點第二次就沒反應。
  page.querySelectorAll("[data-size-step]").forEach((btn) => {
    btn.onclick = () => {
      const current = getSelectionClassWithPrefix(notesEditable, "fs-");
      if (current === undefined) {
        toast("請先選取要調整字級的文字");
        return;
      }
      const currentIndex = current ? SIZE_LEVELS.indexOf(current) : SIZE_LEVELS.indexOf(null);
      const nextIndex = Math.max(0, Math.min(SIZE_LEVELS.length - 1, currentIndex + Number(btn.dataset.sizeStep)));
      notesEditable.focus();
      applyInlineStyle(notesEditable, "size", SIZE_LEVELS[nextIndex]);
    };
  });
  page.querySelector("[data-bold]").onclick = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      toast("請先選取要加粗的文字");
      return;
    }
    notesEditable.focus();
    document.execCommand("bold");
  };
  page.querySelector("[data-underline]").onclick = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      toast("請先選取要加底線的文字");
      return;
    }
    notesEditable.focus();
    document.execCommand("underline");
  };
  page.querySelector("[data-clear]").onclick = () => {
    notesEditable.focus();
    if (!clearInlineStyle(notesEditable)) toast("請先選取要清除格式的文字");
  };

  page.querySelector("[data-add-word]").onclick = () => {
    openEditorModal({ mode: "create", courseId: course.id });
  };

  page.querySelector("[data-review-course]")?.addEventListener("click", () => {
    location.hash = `#/review?course=${course.id}`;
  });

  page.querySelector("[data-mark-pending]").onclick = () => {
    location.hash = `#/pending?for_course=${course.id}`;
  };

  const attachmentInput = page.querySelector("#course-attachment-input");
  page.querySelector("[data-upload-attachment]").onclick = () => attachmentInput.click();
  attachmentInput.addEventListener("change", async () => {
    const files = [...attachmentInput.files];
    attachmentInput.value = "";
    if (!files.length) return;
    try {
      for (const file of files) {
        await db.addAttachment(course.id, file);
      }
      toast(files.length > 1 ? `已上傳 ${files.length} 個附件` : "已上傳附件");
      triggerRefresh();
    } catch (err) {
      toast(err.message || "上傳失敗");
    }
  });

  page.querySelectorAll("[data-delete-attachment]").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("確定要刪除這個附件嗎？")) return;
      try {
        await db.deleteAttachment(btn.dataset.deleteAttachment);
        toast("已刪除附件");
        triggerRefresh();
      } catch (err) {
        toast(err.message || "刪除失敗");
      }
    };
  });

  page.querySelector("[data-delete-course]").onclick = async () => {
    if (!confirm(`確定要刪除「${course.title || "這堂課"}」嗎？單字本身不會被刪除，只會移除它們跟這堂課的連結。`)) return;
    try {
      await db.deleteCourse(course.id);
      toast("已刪除課程");
      location.hash = "#/courses";
    } catch (err) {
      toast(err.message || "刪除失敗");
    }
  };

  page.querySelectorAll("[data-jump-word]").forEach((item) => {
    item.onclick = () => openDetailPanel(item.dataset.jumpWord);
  });

  page.querySelectorAll("[data-unlink]").forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      try {
        await db.unlinkNodeFromCourse(btn.dataset.unlink);
        toast("已移除連結");
        triggerRefresh();
      } catch (err) {
        toast(err.message || "移除失敗");
      }
    };
  });

  const linkedIds = new Set(words.map((w) => w.node.id));
  const searchInput = page.querySelector("#course-word-search");
  const suggestBox = page.querySelector("#course-word-suggest");
  let debounce;
  searchInput.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const q = searchInput.value.trim();
      if (!q) {
        suggestBox.hidden = true;
        suggestBox.innerHTML = `<div class="suggest-empty">開始輸入以搜尋既有內容</div>`;
        return;
      }
      suggestBox.hidden = false;
      const results = (await db.searchNodes(q)).filter((n) => !linkedIds.has(n.id)).slice(0, 8);
      suggestBox.innerHTML =
        results
          .map(
            (n) => `<div class="suggest-item" data-link-node="${n.id}">
              <span class="type-badge type-${n.type}">${typeLabel(n.type)}</span>
              <span>${escapeHtml(n.headword)}</span>
              <span class="hint">${escapeHtml((n.type === "grammar" ? grammarPreviewText(n) : n.translation) || "")}</span>
            </div>`
          )
          .join("") || `<div class="suggest-empty">沒有符合的內容（或已經連結過了）</div>`;
      suggestBox.querySelectorAll("[data-link-node]").forEach((item) => {
        item.onclick = async () => {
          try {
            await db.linkNodeToCourse(item.dataset.linkNode, course.id);
            toast("已連結單字");
            triggerRefresh();
          } catch (err) {
            toast(err.message || "連結失敗");
          }
        };
      });
    }, 150);
  });
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) {
  return escapeHtml(str);
}
