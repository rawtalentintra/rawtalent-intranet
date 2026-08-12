// Replaces Jodit — a headless TipTap editor with a custom toolbar built to
// match RawTalent HeartBeat's own navy/orange design system, instead of a
// generic third-party skin. Exposes a `.value` getter/setter so existing
// call sites (admin.html's `joditEditor.value`, `projectSopEditor.value`)
// keep working unchanged.
import { Editor } from 'https://esm.sh/@tiptap/core@2';
import StarterKit from 'https://esm.sh/@tiptap/starter-kit@2';
import Underline from 'https://esm.sh/@tiptap/extension-underline@2';
import Link from 'https://esm.sh/@tiptap/extension-link@2';
import ImageExt from 'https://esm.sh/@tiptap/extension-image@2';
import TextStyle from 'https://esm.sh/@tiptap/extension-text-style@2';
import Color from 'https://esm.sh/@tiptap/extension-color@2';
import TextAlign from 'https://esm.sh/@tiptap/extension-text-align@2';
import Placeholder from 'https://esm.sh/@tiptap/extension-placeholder@2';
import Table from 'https://esm.sh/@tiptap/extension-table@2';
import TableRow from 'https://esm.sh/@tiptap/extension-table-row@2';
import TableHeader from 'https://esm.sh/@tiptap/extension-table-header@2';
import TableCell from 'https://esm.sh/@tiptap/extension-table-cell@2';

// Small hand-built stroke icons (24x24 viewBox, currentColor) — kept simple
// on purpose (lines/rects/circles, no external icon font) so there's no
// extra CDN dependency and no flash-of-unstyled-icon on load.
const ICON = {
  quote: '<path d="M7 7h4v6H8c0 2-1 3-3 3v2c4 0 6-2 6-5V5H7v2zm10 0h4v6h-3c0 2-1 3-3 3v2c4 0 6-2 6-5V5h-4v2z"/>',
  bulletList: '<circle cx="4" cy="6" r="1.4"/><circle cx="4" cy="12" r="1.4"/><circle cx="4" cy="18" r="1.4"/><path d="M9 6h11M9 12h11M9 18h11" stroke-width="2" stroke-linecap="round"/>',
  orderedList: '<text x="1" y="8" font-size="7" fill="currentColor" stroke="none">1</text><text x="1" y="14.5" font-size="7" fill="currentColor" stroke="none">2</text><text x="1" y="21" font-size="7" fill="currentColor" stroke="none">3</text><path d="M9 6h11M9 12h11M9 18h11" stroke-width="2" stroke-linecap="round"/>',
  link: '<path d="M9 15l6-6M8.5 13.5l-2 2a3.5 3.5 0 0 0 5 5l2-2M15.5 10.5l2-2a3.5 3.5 0 0 0-5-5l-2 2" stroke-width="2" stroke-linecap="round"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2" stroke-width="2"/><circle cx="8.5" cy="9.5" r="1.7" stroke-width="2"/><path d="M21 16l-5.5-5.5L6 20" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="1.5" stroke-width="2"/><path d="M3 9.5h18M3 15h18M9.5 4v16M15 4v16" stroke-width="1.6"/>',
  hr: '<path d="M4 12h16" stroke-width="2.5" stroke-linecap="round"/>',
  undo: '<path d="M8 7L4 11l4 4M4 11h10a6 6 0 1 1 0 12h-2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  redo: '<path d="M16 7l4 4-4 4M20 11H10a6 6 0 1 0 0 12h2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  clear: '<path d="M3 17h7M13 3l8 8-9.5 9.5H8L3 16 13 3z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  expand: '<path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  collapse: '<path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  alignLeft: '<path d="M4 6h16M4 12h10M4 18h14" stroke-width="2" stroke-linecap="round"/>',
  alignCenter: '<path d="M4 6h16M8 12h8M5 18h14" stroke-width="2" stroke-linecap="round"/>',
  alignRight: '<path d="M4 6h16M10 12h10M6 18h14" stroke-width="2" stroke-linecap="round"/>',
  color: '<path d="M12 3l7 12H5L12 3z" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="19" r="2" stroke-width="2"/>',
  chevronDown: '<path d="M6 9l6 6 6-6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  rowAdd: '<rect x="3" y="4" width="18" height="7" rx="1.5" stroke-width="2"/><path d="M12 15v6M9 18h6" stroke-width="2" stroke-linecap="round"/>',
  colAdd: '<rect x="4" y="3" width="7" height="18" rx="1.5" stroke-width="2"/><path d="M17 8v8M14 12h6" stroke-width="2" stroke-linecap="round"/>'
};
function svg(name, size = 17) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor">${ICON[name]}</svg>`;
}

const COLOR_SWATCHES = ['#1a2b4c', '#c2410c', '#b91c1c', '#15803d', '#0369a1', '#7e22ce', '#334155', '#000000'];

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function makeButton({ icon, text, title, onClick }) {
  const btn = el('button', 'rte-btn', icon ? svg(icon) : text);
  btn.type = 'button';
  btn.title = title || '';
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep editor selection/focus
  btn.addEventListener('click', onClick);
  return btn;
}
function divider() { return el('span', 'rte-divider'); }

function closeAllPopovers(root) {
  root.querySelectorAll('.rte-popover.open').forEach(p => p.classList.remove('open'));
}

function buildToolbar(toolbarEl, editor, preset, rootEl) {
  const groups = [];
  const textGroup = el('div', 'rte-group');
  // Heading / paragraph dropdown
  const headingBtn = makeButton({ text: 'Normal <span class="rte-caret">' + svg('chevronDown', 12) + '</span>', title: 'Paragraph style' });
  headingBtn.classList.add('rte-btn-wide');
  const headingMenu = el('div', 'rte-popover');
  [['Paragraph', 0], ['Heading 1', 1], ['Heading 2', 2], ['Heading 3', 3]].forEach(([label, level]) => {
    const item = el('button', 'rte-menu-item', label);
    item.type = 'button';
    item.style.fontWeight = level ? '800' : '500';
    item.style.fontSize = level === 1 ? '17px' : level === 2 ? '15px' : level === 3 ? '13.5px' : '13px';
    item.addEventListener('mousedown', (e) => e.preventDefault());
    item.addEventListener('click', () => {
      if (level === 0) editor.chain().focus().setParagraph().run();
      else editor.chain().focus().toggleHeading({ level }).run();
      closeAllPopovers(rootEl);
    });
    headingMenu.appendChild(item);
  });
  const headingWrap = el('div', 'rte-dropdown');
  headingWrap.appendChild(headingBtn);
  headingWrap.appendChild(headingMenu);
  headingBtn.addEventListener('click', () => { const open = headingMenu.classList.contains('open'); closeAllPopovers(rootEl); headingMenu.classList.toggle('open', !open); });
  textGroup.appendChild(headingWrap);
  groups.push(textGroup);
  groups.push(divider());

  const markGroup = el('div', 'rte-group');
  markGroup.appendChild(makeButton({ text: '<b>B</b>', title: 'Bold (Ctrl+B)', onClick: () => editor.chain().focus().toggleBold().run() }));
  markGroup.appendChild(makeButton({ text: '<i>I</i>', title: 'Italic (Ctrl+I)', onClick: () => editor.chain().focus().toggleItalic().run() }));
  markGroup.appendChild(makeButton({ text: '<u>U</u>', title: 'Underline (Ctrl+U)', onClick: () => editor.chain().focus().toggleUnderline().run() }));
  markGroup.appendChild(makeButton({ text: '<s>S</s>', title: 'Strikethrough', onClick: () => editor.chain().focus().toggleStrike().run() }));
  groups.push(markGroup);
  groups.push(divider());

  // Color popover
  const colorGroup = el('div', 'rte-group');
  const colorBtn = makeButton({ icon: 'color', title: 'Text colour' });
  const colorMenu = el('div', 'rte-popover rte-popover-swatches');
  COLOR_SWATCHES.forEach(hex => {
    const sw = el('button', 'rte-swatch');
    sw.type = 'button';
    sw.style.background = hex;
    sw.addEventListener('mousedown', (e) => e.preventDefault());
    sw.addEventListener('click', () => { editor.chain().focus().setColor(hex).run(); closeAllPopovers(rootEl); });
    colorMenu.appendChild(sw);
  });
  const resetSw = el('button', 'rte-swatch rte-swatch-reset', '✕');
  resetSw.type = 'button';
  resetSw.title = 'Remove colour';
  resetSw.addEventListener('mousedown', (e) => e.preventDefault());
  resetSw.addEventListener('click', () => { editor.chain().focus().unsetColor().run(); closeAllPopovers(rootEl); });
  colorMenu.appendChild(resetSw);
  const colorWrap = el('div', 'rte-dropdown');
  colorWrap.appendChild(colorBtn);
  colorWrap.appendChild(colorMenu);
  colorBtn.addEventListener('click', () => { const open = colorMenu.classList.contains('open'); closeAllPopovers(rootEl); colorMenu.classList.toggle('open', !open); });
  colorGroup.appendChild(colorWrap);
  groups.push(colorGroup);
  groups.push(divider());

  const blockGroup = el('div', 'rte-group');
  blockGroup.appendChild(makeButton({ icon: 'quote', title: 'Quote', onClick: () => editor.chain().focus().toggleBlockquote().run() }));
  blockGroup.appendChild(makeButton({ icon: 'bulletList', title: 'Bullet list', onClick: () => editor.chain().focus().toggleBulletList().run() }));
  blockGroup.appendChild(makeButton({ icon: 'orderedList', title: 'Numbered list', onClick: () => editor.chain().focus().toggleOrderedList().run() }));
  groups.push(blockGroup);
  groups.push(divider());

  if (preset === 'full') {
    const alignGroup = el('div', 'rte-group');
    alignGroup.appendChild(makeButton({ icon: 'alignLeft', title: 'Align left', onClick: () => editor.chain().focus().setTextAlign('left').run() }));
    alignGroup.appendChild(makeButton({ icon: 'alignCenter', title: 'Align centre', onClick: () => editor.chain().focus().setTextAlign('center').run() }));
    alignGroup.appendChild(makeButton({ icon: 'alignRight', title: 'Align right', onClick: () => editor.chain().focus().setTextAlign('right').run() }));
    groups.push(alignGroup);
    groups.push(divider());
  }

  const insertGroup = el('div', 'rte-group');
  insertGroup.appendChild(makeButton({
    icon: 'link', title: 'Link',
    onClick: () => {
      const prev = editor.getAttributes('link').href;
      const url = prompt(prev ? 'Edit link URL (blank to remove):' : 'Link URL:', prev || 'https://');
      if (url === null) return;
      if (!url.trim()) { editor.chain().focus().unsetLink().run(); return; }
      editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
    }
  }));
  if (preset === 'full') {
    const imgInput = el('input');
    imgInput.type = 'file';
    imgInput.accept = 'image/*';
    imgInput.style.display = 'none';
    imgInput.addEventListener('change', () => {
      const file = imgInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => editor.chain().focus().setImage({ src: reader.result }).run();
      reader.readAsDataURL(file);
      imgInput.value = '';
    });
    insertGroup.appendChild(imgInput);
    insertGroup.appendChild(makeButton({ icon: 'image', title: 'Insert image', onClick: () => imgInput.click() }));
  }

  // Table button — inserts a table, or if the cursor is already inside one,
  // opens a menu of row/column/delete actions instead.
  const tableBtn = makeButton({ icon: 'table', title: 'Table' });
  const tableMenu = el('div', 'rte-popover');
  const tableActions = [
    ['rowAdd', 'Add row below', () => editor.chain().focus().addRowAfter().run()],
    ['colAdd', 'Add column right', () => editor.chain().focus().addColumnAfter().run()],
    ['trash', 'Delete row', () => editor.chain().focus().deleteRow().run()],
    ['trash', 'Delete column', () => editor.chain().focus().deleteColumn().run()],
    ['trash', 'Delete table', () => editor.chain().focus().deleteTable().run()]
  ];
  tableActions.forEach(([icon, label, fn]) => {
    const item = el('button', 'rte-menu-item', `${svg(icon, 15)}<span>${label}</span>`);
    item.type = 'button';
    item.addEventListener('mousedown', (e) => e.preventDefault());
    item.addEventListener('click', () => { fn(); closeAllPopovers(rootEl); });
    tableMenu.appendChild(item);
  });
  const tableWrap = el('div', 'rte-dropdown');
  tableWrap.appendChild(tableBtn);
  tableWrap.appendChild(tableMenu);
  tableBtn.addEventListener('click', () => {
    if (editor.isActive('table')) {
      const open = tableMenu.classList.contains('open');
      closeAllPopovers(rootEl);
      tableMenu.classList.toggle('open', !open);
    } else {
      editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    }
  });
  insertGroup.appendChild(tableWrap);
  insertGroup.appendChild(makeButton({ icon: 'hr', title: 'Horizontal rule', onClick: () => editor.chain().focus().setHorizontalRule().run() }));
  groups.push(insertGroup);
  groups.push(divider());

  const historyGroup = el('div', 'rte-group');
  historyGroup.appendChild(makeButton({ icon: 'undo', title: 'Undo (Ctrl+Z)', onClick: () => editor.chain().focus().undo().run() }));
  historyGroup.appendChild(makeButton({ icon: 'redo', title: 'Redo (Ctrl+Shift+Z)', onClick: () => editor.chain().focus().redo().run() }));
  historyGroup.appendChild(makeButton({ icon: 'clear', title: 'Clear formatting', onClick: () => editor.chain().focus().unsetAllMarks().clearNodes().run() }));
  groups.push(historyGroup);

  const spacer = el('div', 'rte-spacer');
  const fullscreenBtn = makeButton({ icon: 'expand', title: 'Fullscreen', onClick: () => {
    const isFull = rootEl.classList.toggle('rte-fullscreen');
    fullscreenBtn.innerHTML = svg(isFull ? 'collapse' : 'expand');
  } });

  groups.forEach(g => toolbarEl.appendChild(g));
  toolbarEl.appendChild(spacer);
  toolbarEl.appendChild(fullscreenBtn);

  document.addEventListener('click', (e) => {
    if (!rootEl.contains(e.target)) closeAllPopovers(rootEl);
  });

  return {
    refresh() {
      const setActive = (btn, active) => btn && btn.classList.toggle('rte-btn-active', !!active);
      setActive(markGroup.children[0], editor.isActive('bold'));
      setActive(markGroup.children[1], editor.isActive('italic'));
      setActive(markGroup.children[2], editor.isActive('underline'));
      setActive(markGroup.children[3], editor.isActive('strike'));
      setActive(blockGroup.children[0], editor.isActive('blockquote'));
      setActive(blockGroup.children[1], editor.isActive('bulletList'));
      setActive(blockGroup.children[2], editor.isActive('orderedList'));
      const level = [1, 2, 3].find(l => editor.isActive('heading', { level: l }));
      headingBtn.querySelector.call; // no-op guard for older browsers
      const label = level ? `Heading ${level}` : 'Normal';
      headingBtn.innerHTML = `${label} <span class="rte-caret">${svg('chevronDown', 12)}</span>`;
    }
  };
}

export function createEditor(mountEl, { preset = 'full', placeholder = '', onUpdate } = {}) {
  mountEl.innerHTML = '';
  mountEl.classList.add('rte-root');
  const toolbarEl = el('div', 'rte-toolbar');
  const contentWrap = el('div', 'rte-content-wrap');
  const contentEl = el('div', 'rte-content');
  contentWrap.appendChild(contentEl);
  mountEl.appendChild(toolbarEl);
  mountEl.appendChild(contentWrap);

  // Declared (not just assigned) before `new Editor(...)` — TipTap fires an
  // initial onTransaction/onUpdate synchronously as part of construction,
  // before this function reaches the `buildToolbar()` call below. With
  // `const toolbar` declared only after the Editor constructor, that initial
  // callback referenced `toolbar` while it was still in the temporal dead
  // zone and threw `ReferenceError: Cannot access 'toolbar' before
  // initialization` — confirmed live, and since the whole rest of this
  // function (buildToolbar, the return statement) never ran when it threw,
  // `RichEditor.create()` itself threw instead of returning, which is why
  // the editor never actually finished mounting for anyone.
  let toolbar;
  const editor = new Editor({
    element: contentEl,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Underline,
      TextStyle,
      Color,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer' } }),
      ImageExt,
      Placeholder.configure({ placeholder }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell
    ],
    content: '',
    onUpdate: ({ editor }) => { if (onUpdate) onUpdate(editor.isEmpty ? '' : editor.getHTML()); toolbar?.refresh(); },
    onSelectionUpdate: () => toolbar?.refresh(),
    onTransaction: () => toolbar?.refresh()
  });

  toolbar = buildToolbar(toolbarEl, editor, preset, mountEl);
  toolbar.refresh();

  return {
    get value() { return editor.isEmpty ? '' : editor.getHTML(); },
    set value(html) { editor.commands.setContent(html || '', false); toolbar.refresh(); },
    focus() { editor.commands.focus(); },
    destroy() { editor.destroy(); }
  };
}

window.RichEditor = { create: createEditor };
window.__richEditorReady = true;
window.dispatchEvent(new Event('richeditor-ready'));
