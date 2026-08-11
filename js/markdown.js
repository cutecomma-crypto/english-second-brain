// Minimal Markdown -> HTML renderer for course notes (PRD Stage 06.4 —
// a pure text-in/HTML-out function, no editor library needed).
// Supports exactly what the course learning page needs: h1/h2 headings,
// paragraphs, bullet lists, numbered lists, bold, links, blockquotes,
// and a bounded set of highlight colors / font sizes (see COLORS/SIZES —
// deliberately a fixed palette, not a free color/size picker, so notes
// stay visually consistent and the renderer never has to trust arbitrary
// user-supplied CSS).

export const COLORS = ["red", "orange", "green", "blue", "purple"];
// SIZES：舊版 [big]/[small] 純文字標記用的名字，只給 renderInline() 解析
// 舊資料用。新版 WYSIWYG 編輯器的「一直點可以一直放大/縮小」用下面的
// SIZE_LEVELS 階梯，兩者的 class 名稱重疊（fs-big/fs-small）所以舊資料
// 轉換出來的 HTML 跟新系統完全相容，不用另外遷移。
export const SIZES = ["big", "small"];
// 由小到大：中間 null 代表「正常大小」（不加任何 class）。放大/縮小的
// 「A+/A-」按鈕每點一次，就是在這個陣列上前進/後退一格，而不是套用固定
// 的一個大小，這樣才能連續點好幾次持續變大或變小。縮小 3 級、放大 5 級，
// 刻意不對稱——筆記通常更常需要「強調重點放很大」，縮小則多半只是次要
// 補充，不太需要縮到極小。
export const SIZE_LEVELS = [
  "fs-xxs",
  "fs-xs",
  "fs-small",
  null,
  "fs-big",
  "fs-xl",
  "fs-2xl",
  "fs-3xl",
  "fs-4xl",
];

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderInline(line) {
  let text = escapeHtml(line);
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const colorAlt = COLORS.join("|");
  text = text.replace(new RegExp(`\\[(${colorAlt})\\]([\\s\\S]*?)\\[/\\1\\]`, "g"), '<span class="hl-$1">$2</span>');
  const sizeAlt = SIZES.join("|");
  text = text.replace(new RegExp(`\\[(${sizeAlt})\\]([\\s\\S]*?)\\[/\\1\\]`, "g"), '<span class="fs-$1">$2</span>');
  return text;
}

// 逐行掃描而不是先用空行切區塊——舊版要求「一整段裡每一行都是條列」才會被
// 當成清單，只要條列後面緊接著一般文字（中間沒有空行，例如用工具列按鈕在
// 一段說明後面直接加條列）整段就會整個判斷失敗、退回純文字段落，「- 」就
// 會直接照字面印出來，跟正常轉成 <ul> 圓點的清單看起來不一致。改成連續同
// 類型的行各自成一段，不需要空行分隔就能正確辨識。
function renderMarkdown(source) {
  const text = (source || "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";

  const rawLines = text.split("\n");
  const isBullet = (l) => /^[-*]\s+/.test(l.trim());
  const isNumbered = (l) => /^\d+[.)]\s+/.test(l.trim());
  const isQuote = (l) => /^>\s?/.test(l.trim());
  const isHeading = (l) => /^#{1,2}\s+/.test(l.trim());

  const html = [];
  let i = 0;
  while (i < rawLines.length) {
    const trimmed = rawLines[i].trim();
    if (trimmed === "") {
      i++;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,2})\s+(.*)$/);
    if (headingMatch) {
      const tag = headingMatch[1].length === 1 ? "h2" : "h3";
      html.push(`<${tag}>${renderInline(headingMatch[2])}</${tag}>`);
      i++;
      continue;
    }

    if (isBullet(trimmed)) {
      const items = [];
      while (i < rawLines.length && isBullet(rawLines[i])) {
        items.push(`<li>${renderInline(rawLines[i].trim().replace(/^[-*]\s+/, ""))}</li>`);
        i++;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (isNumbered(trimmed)) {
      const items = [];
      while (i < rawLines.length && isNumbered(rawLines[i])) {
        items.push(`<li>${renderInline(rawLines[i].trim().replace(/^\d+[.)]\s+/, ""))}</li>`);
        i++;
      }
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    if (isQuote(trimmed)) {
      const quoted = [];
      while (i < rawLines.length && rawLines[i].trim() !== "" && isQuote(rawLines[i])) {
        quoted.push(renderInline(rawLines[i].trim().replace(/^>\s?/, "")));
        i++;
      }
      html.push(`<blockquote>${quoted.join("<br>")}</blockquote>`);
      continue;
    }

    const paraLines = [];
    while (
      i < rawLines.length &&
      rawLines[i].trim() !== "" &&
      !isHeading(rawLines[i]) &&
      !isBullet(rawLines[i]) &&
      !isNumbered(rawLines[i]) &&
      !isQuote(rawLines[i])
    ) {
      paraLines.push(rawLines[i].trim());
      i++;
    }
    html.push(`<p>${paraLines.map(renderInline).join("<br>")}</p>`);
  }
  return html.join("");
}

// 課堂筆記編輯器從 v1（<textarea> + [red]...[/red] 純文字標記）換成 v2
// （contenteditable 所見即所得，存成真正的 HTML）。判斷「這筆課程內容是
// 舊格式還是新格式」只看開頭是不是長得像 HTML 標籤——舊資料一律先過
// renderMarkdown() 轉成一樣的 <span class="hl-red">／<span class="fs-big">
// 結構，新舊資料在畫面上看起來完全一樣，也不需要額外跑一次遷移。
function looksLikeHtml(content) {
  // 不能只檢查「開頭是不是標籤」——如果存檔前有文字沒被包進區塊元素
  // （見 wrapStrayText，這裡順便修正這種舊資料），內容會變成「文字
  // 開頭、標籤在後面」，錨定在開頭的判斷會誤判成舊版純文字格式，反而
  // 把裡面的 HTML 標籤當成文字逐字顯示出來（畫面上看到一堆 <p></p>）。
  // 改成只要「內容裡任何地方」出現這些標籤就視為新格式。
  return /<(p|h2|h3|ul|ol|blockquote|div)[ >]/i.test(content || "");
}

// 顯示／編輯器帶入時都走這個統一入口：新格式（HTML）先清理過再輸出，
// 舊格式（純文字＋方括號標記）用原本的 renderMarkdown 轉成同樣的 HTML。
export function renderNotesContent(content) {
  if (!content) return "";
  return looksLikeHtml(content) ? sanitizeHtml(content) : renderMarkdown(content);
}

// contenteditable 存檔前、以及把舊格式轉出來的 HTML 顯示前，都要過這一關——
// 白名單只留筆記真的會用到的標籤／屬性，其餘一律拆掉（保留內文文字，
// 只是不再是標籤），避免貼上的內容夾帶 <script>、onerror 這類東西。
const ALLOWED_TAGS = new Set(["P", "BR", "H2", "H3", "UL", "OL", "LI", "BLOCKQUOTE", "STRONG", "B", "EM", "I", "U", "A", "SPAN", "DIV"]);
const ALLOWED_SPAN_CLASSES = new Set([...COLORS.map((c) => `hl-${c}`), ...SIZE_LEVELS.filter(Boolean)]);
// 這些標籤整個移除（含內容）——不能只拆標籤留文字，不然 <script> 裡的原始
// 程式碼會被當成純文字留在筆記裡，變成畫面上一大段看不懂的雜訊。
const STRIP_WITH_CONTENT = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "NOSCRIPT", "SVG", "TEMPLATE"]);

export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  sanitizeNode(doc.body);
  return doc.body.innerHTML;
}

function sanitizeNode(root) {
  [...root.querySelectorAll("*")].forEach((el) => {
    if (STRIP_WITH_CONTENT.has(el.tagName)) {
      el.remove();
      return;
    }
    if (!ALLOWED_TAGS.has(el.tagName)) {
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      return;
    }
    if (el.tagName === "A") {
      const href = el.getAttribute("href") || "";
      [...el.attributes].forEach((attr) => el.removeAttribute(attr.name));
      if (/^https?:\/\//i.test(href)) {
        el.setAttribute("href", href);
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
      return;
    }
    if (el.tagName === "SPAN") {
      const keepClasses = (el.getAttribute("class") || "").split(/\s+/).filter((c) => ALLOWED_SPAN_CLASSES.has(c));
      [...el.attributes].forEach((attr) => el.removeAttribute(attr.name));
      if (keepClasses.length) el.setAttribute("class", keepClasses.join(" "));
      return;
    }
    [...el.attributes].forEach((attr) => el.removeAttribute(attr.name));
  });
}

// 拆掉 fragment 裡所有樣式標籤（保留文字本身），如果指定了 keepPrefix，
// 會記住第一個符合這個前綴的 class（例如套顏色時記住原本的字級 class），
// 讓呼叫端能把它合併回新的 span，而不是留下兩層巢狀。除了 <span> 也一併
// 處理 <font>——瀏覽器在某些操作（例如換行時延續游標當下的顏色）會用
// <font color="..."> 這種舊式標籤，不是只有我們自己套用時用的 <span
// class="hl-...">，只清 span 會漏掉這種情況。
function flattenSpans(fragment, keepPrefix) {
  let keptClass = null;
  [...fragment.querySelectorAll("span, font")].forEach((span) => {
    if (keepPrefix) {
      const classes = (span.getAttribute("class") || "").split(/\s+/).filter(Boolean);
      const kept = classes.find((c) => c.startsWith(keepPrefix));
      if (kept && !keptClass) keptClass = kept;
    }
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  });
  return keptClass;
}

// range.extractContents() 在選取範圍剛好等於一個文字節點全部內容時，只會
// 抽走文字、把原本包著它的樣式標籤原地留下、變成空的——不清掉的話會愈積
// 愈多空標籤，不符合「產生的 HTML 要乾淨」的要求。
function removeEmptySpans(container) {
  [...container.querySelectorAll("span, font")].forEach((span) => {
    if (span.textContent === "") span.remove();
  });
}

// extractContents() 在選取範圍剛好等於一個文字節點全部內容時，只會抽走
// 文字本身，原本包著它的 <span> 不會一起進到 fragment 裡，而是原地留下、
// 變成空殼。這件事有兩個後果：
//  1. range 會被 collapse 在這個空殼「裡面」，這時候如果直接
//     range.insertNode(新內容)，DOM 規格規定新節點要插進 range 容器的
//     父層——也就是那個空殼內部，變成「新 span 被包在舊空殼裡」而不是
//     取代它。舊殼還留著舊的 line-height，行距會像沒恢復一樣。
//  2. 因為空殼從沒進到 fragment，flattenSpans() 根本看不到它身上的
//     class，選取範圍剛好是「整個舊 span 的文字」時（最常見的情況：選
//     剛套色過的字去改字級），另一個類別的樣式（例如顏色）會直接遺失，
//     不是被保留合併，而是憑空消失。
// 這裡把空殼拆掉、range 移到空殼原本的位置（新內容才會插在正確的外層
// 容器下，不會被舊殼包住），並且把空殼原本的 class 回傳出去，讓呼叫端
// 可以把裡面「另一類別」的樣式（例如 fs-big）合併進新的 span，不會遺失。
function collapseOutOfEmptyStyleSpan(range) {
  const container = range.startContainer;
  const span = container.nodeType === 3 ? container.parentNode : container;
  if (span && (span.tagName === "SPAN" || span.tagName === "FONT") && span.textContent === "" && span.parentNode) {
    const oldClass = span.getAttribute("class");
    const parent = span.parentNode;
    const index = [...parent.childNodes].indexOf(span);
    parent.removeChild(span);
    range.setStart(parent, index);
    range.collapse(true);
    return oldClass;
  }
  return null;
}

// 套用顏色／字級到目前的 DOM 選取範圍。同一類別（顏色 vs 顏色、字級 vs
// 字級）先整段拆乾淨再套新的，不會疊出兩層同類型的 span；另一個類別
// （例如套顏色時的字級）如果本來就有，會合併進同一個 span，不會巢狀。
// className 可以傳 null，代表「這個類別還原成沒有樣式」（但保留另一個
// 類別，例如字級退回正常大小時不會連顏色一起清掉）。selection 是空的時
// 不做任何事，回傳 false 讓呼叫端提示使用者先選字。
export function applyInlineStyle(container, category, className) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return false;

  const keepPrefix = category === "color" ? "fs-" : "hl-";
  const fragment = range.extractContents();
  let keptClass = flattenSpans(fragment, keepPrefix);
  const shellClass = collapseOutOfEmptyStyleSpan(range);
  if (!keptClass && shellClass) {
    keptClass = shellClass.split(/\s+/).find((c) => c.startsWith(keepPrefix)) || null;
  }

  const span = document.createElement("span");
  const classes = [className, keptClass].filter(Boolean);
  if (classes.length) span.className = classes.join(" ");
  span.appendChild(fragment);
  range.insertNode(span);
  removeEmptySpans(container);

  const newRange = document.createRange();
  newRange.selectNodeContents(span);
  sel.removeAllRanges();
  sel.addRange(newRange);
  return true;
}

// 讀取目前選取範圍「起點」所在的樣式 span，找出符合這個前綴的 class（不
// 修改任何東西）——用來判斷「現在是第幾級」，才能算出「再放大/縮小一級」
// 應該套用哪一個 class。選取範圍是空的時回傳 undefined（呼叫端應該中止並
// 提示使用者先選字）；有選取但找不到符合的樣式時回傳 null（代表目前是
// 正常大小/沒有顏色）。
export function getSelectionClassWithPrefix(container, prefix) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return undefined;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return undefined;

  let node = range.startContainer;
  if (node.nodeType === 3) node = node.parentNode;
  while (node && node !== container) {
    if (node.tagName === "SPAN") {
      const found = (node.getAttribute("class") || "").split(/\s+/).find((c) => c.startsWith(prefix));
      if (found) return found;
    }
    node = node.parentNode;
  }
  return null;
}

// 清除格式：把選取範圍內所有顏色／字級 span 整個拆掉，還原成純文字（預設
// 黑字、預設字級）。
export function clearInlineStyle(container) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return false;

  const fragment = range.extractContents();
  flattenSpans(fragment, null); // 拆掉 <span>/<font>，保留文字
  // 保險起見，選取範圍內任何「還留著」的元素（包含 <li>、<p> 這類結構
  // 元素）身上如果殘留了 style 屬性或 hl-*/fs-* class（例如條列化時被
  // 瀏覽器一併帶過去的），這裡一併清掉，不拆結構本身。
  [...fragment.querySelectorAll("[style], [class]")].forEach((el) => {
    el.removeAttribute("style");
    const keptClasses = (el.getAttribute("class") || "").split(/\s+/).filter((c) => c && !c.startsWith("hl-") && !c.startsWith("fs-"));
    if (keptClasses.length) el.setAttribute("class", keptClasses.join(" "));
    else el.removeAttribute("class");
  });
  collapseOutOfEmptyStyleSpan(range);
  range.insertNode(fragment);
  removeEmptySpans(container);
  sel.removeAllRanges();
  return true;
}

// 換行後，瀏覽器常常會讓游標當下的「打字格式」延續上一行的顏色／字級
// ——這個機制不一定會反映在乾淨的 DOM 結構上（有時是 <span> 包 class，
// 有時是 <font> 標籤，有時是內嵌 style），單純往上找特定標籤/class 名稱
// 沒辦法涵蓋所有情況。既然游標所在的這個區塊目前完全沒有真正打過的文字
// （不然不會呼叫這個函式），直接把它整個清空、重建成最乾淨的
// 「<p><br></p>」（或 <li><br></li>），不管殘留的樣式是用什麼形式存在，
// 全部一次歸零——游標的「目前格式」自然也就沒有東西可以繼承。
export function escapeEmptyStyleSpanAtCursor(container) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType === 3) node = node.parentNode;

  let block = node;
  while (block && block !== container && !BLOCK_TAGS.has(block.tagName) && block.tagName !== "LI") {
    block = block.parentNode;
  }
  if (!block || block === container || block.textContent !== "") return;

  block.innerHTML = "";
  block.appendChild(document.createElement("br"));
  const range = document.createRange();
  range.setStart(block, 0);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

const BLOCK_TAGS = new Set(["P", "H2", "H3", "UL", "OL", "BLOCKQUOTE", "DIV"]);

// 存檔前保險：確保 contenteditable 最外層每一段文字都真的包在區塊元素
// （<p> 等）裡面。正常輸入時 defaultParagraphSeparator 會處理這件事，但
// 使用者在完全空白的編輯區「打的第一段字」有機會直接變成容器的直接子
// 文字節點、沒被包進任何 <p>——存檔後內容會變成「文字開頭、標籤在後面」
// 這種不乾淨的結構，也是 looksLikeHtml() 需要放寬判斷的原因。這裡直接
// 把裸露在外的文字／行內內容包進一個新的 <p>，讓存檔的 HTML 結構固定
// 都是合法的區塊元素，不會再有裸文字。
export function wrapStrayText(container) {
  let current = null;
  [...container.childNodes].forEach((node) => {
    const isBlock = node.nodeType === 1 && BLOCK_TAGS.has(node.tagName);
    if (isBlock) {
      current = null;
      return;
    }
    if (node.nodeType === 3 && node.textContent.trim() === "") return; // 純空白文字節點不用管
    if (!current) {
      current = document.createElement("p");
      container.insertBefore(current, node);
    }
    current.appendChild(node);
  });
}
