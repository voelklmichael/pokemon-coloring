import './style.css';
import { decodeImage, fetchImage, nameFromUrl, parseUrls } from './import';
import { DEFAULT_LINE_ART, lineArt, PRESETS, type LineArtSettings, type PresetName } from './lineart';
import { normalizeCard } from './normalize';
import { buildPdf, type Paper } from './pdf';

interface Settings {
  lineArt: LineArtSettings;
  paper: Paper;
  gap: number;
  cutLines: boolean;
  proxy: string;
}

interface Card {
  id: number;
  name: string;
  source: ImageData;
  lineart: HTMLCanvasElement;
  copies: number;
  el: HTMLElement;
}

const DEFAULT_SETTINGS: Settings = {
  lineArt: DEFAULT_LINE_ART,
  paper: 'a4',
  gap: 2,
  cutLines: true,
  proxy: '',
};
const STORAGE_KEY = 'pokemon-coloring:settings';

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;

const settings = loadSettings();
const cards: Card[] = [];
let nextId = 1;

function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved) return { ...DEFAULT_SETTINGS, ...saved, lineArt: { ...DEFAULT_LINE_ART, ...saved.lineArt } };
  } catch {
    // storage unavailable or corrupt: fall back to defaults
  }
  return structuredClone(DEFAULT_SETTINGS);
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // private mode etc.: settings just won't persist
  }
}

// ---------- messages ----------

function notify(text: string, kind: 'error' | 'info' = 'error') {
  const li = document.createElement('li');
  li.className = kind;
  li.textContent = text;
  const close = document.createElement('button');
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Dismiss');
  close.onclick = () => li.remove();
  li.append(close);
  $('#messages').append(li);
  if (kind === 'info') setTimeout(() => li.remove(), 4000);
}

// ---------- cards ----------

function renderLineArt(card: Card) {
  const { width, height } = card.source;
  const mask = lineArt(card.source, settings.lineArt);
  const out = new ImageData(width, height);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const v = mask[i] ? 0 : 255;
    out.data[p] = out.data[p + 1] = out.data[p + 2] = v;
    out.data[p + 3] = 255;
  }
  card.lineart.getContext('2d')!.putImageData(out, 0, 0);
}

function updateCount() {
  const total = cards.reduce((sum, c) => sum + c.copies, 0);
  $('#card-count').textContent = cards.length ? `(${cards.length} cards, ${total} to print)` : '';
  $('#empty-hint').hidden = cards.length > 0;
}

function addCard(bitmap: ImageBitmap, name: string) {
  const source = normalizeCard(bitmap);
  bitmap.close();
  const el = ($<HTMLTemplateElement>('#card-template').content.firstElementChild as HTMLElement).cloneNode(
    true,
  ) as HTMLElement;
  const original = el.querySelector<HTMLCanvasElement>('canvas.original')!;
  const lineart = el.querySelector<HTMLCanvasElement>('canvas.lineart')!;
  for (const c of [original, lineart]) {
    c.width = source.width;
    c.height = source.height;
  }
  original.getContext('2d')!.putImageData(source, 0, 0);

  const card: Card = { id: nextId++, name, source, lineart, copies: 1, el };
  const nameEl = el.querySelector('.card-name')!;
  nameEl.textContent = name;
  nameEl.setAttribute('title', name);
  el.querySelector<HTMLInputElement>('.copies')!.oninput = (e) => {
    const value = Number((e.target as HTMLInputElement).value);
    card.copies = Number.isFinite(value) ? Math.max(0, Math.min(18, Math.round(value))) : 0;
    updateCount();
  };
  el.querySelector<HTMLButtonElement>('.remove')!.onclick = () => {
    cards.splice(cards.indexOf(card), 1);
    el.remove();
    updateCount();
  };

  renderLineArt(card);
  cards.push(card);
  $('#card-grid').append(el);
  updateCount();
}

async function addFromBlob(blob: Blob, name: string) {
  try {
    addCard(await decodeImage(blob), name);
  } catch (err) {
    notify(`Could not add “${name}”: ${(err as Error).message}`);
  }
}

async function addFromUrls(urls: string[]) {
  for (const url of urls) {
    const name = nameFromUrl(url);
    try {
      await addFromBlob(await fetchImage(url, settings.proxy), name);
    } catch (err) {
      notify(`Could not load “${name}”: ${(err as Error).message}`);
    }
  }
}

async function addFiles(files: Iterable<File>) {
  for (const file of files) {
    if (file.type.startsWith('image/')) await addFromBlob(file, file.name);
    else notify(`Skipped “${file.name}”: not an image.`);
  }
}

/** Re-renders all cards after a settings change; a newer change cancels an older run. */
let renderGeneration = 0;
let renderTimer: number | undefined;
function scheduleRerender() {
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(async () => {
    const generation = ++renderGeneration;
    for (const card of [...cards]) {
      if (generation !== renderGeneration) return;
      renderLineArt(card);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, 150);
}

// ---------- import wiring ----------

$<HTMLInputElement>('#file-input').onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  await addFiles(input.files ?? []);
  input.value = '';
};

$('#url-add').onclick = async () => {
  const textarea = $<HTMLTextAreaElement>('#url-input');
  const urls = parseUrls(textarea.value);
  if (!urls.length) {
    notify('Please paste at least one image link (starting with http:// or https://).');
    return;
  }
  textarea.value = '';
  await addFromUrls(urls);
};

const dropzone = $('#dropzone');
dropzone.ondragover = (e) => {
  e.preventDefault();
  dropzone.classList.add('dragging');
};
dropzone.ondragleave = () => dropzone.classList.remove('dragging');
dropzone.ondrop = async (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragging');
  const dt = e.dataTransfer;
  if (!dt) return;
  const files = [...dt.files].filter((f) => f.type.startsWith('image/'));
  if (files.length) return addFiles(files);
  // Image dragged from another browser tab: we only get its URL.
  const urls = parseUrls(dt.getData('text/uri-list') || dt.getData('text/plain'));
  if (urls.length) return addFromUrls(urls);
  notify('Nothing usable was dropped. Try “Copy image” and Ctrl+V instead.');
};

document.addEventListener('paste', async (e) => {
  const items = [...(e.clipboardData?.items ?? [])];
  const images = items.filter((i) => i.kind === 'file' && i.type.startsWith('image/'));
  if (images.length) {
    e.preventDefault();
    for (const item of images) {
      const file = item.getAsFile();
      if (file) await addFromBlob(file, `pasted image ${nextId}`);
    }
    return;
  }
  // Pasting links outside the textarea adds them directly.
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
  const urls = parseUrls(e.clipboardData?.getData('text/plain') ?? '');
  if (urls.length) {
    e.preventDefault();
    await addFromUrls(urls);
  }
});

const proxyInput = $<HTMLInputElement>('#proxy-input');
proxyInput.value = settings.proxy;
proxyInput.onchange = () => {
  settings.proxy = proxyInput.value.trim();
  saveSettings();
};

// ---------- line settings wiring ----------

const sliders = [...document.querySelectorAll<HTMLInputElement>('input[data-setting]')];
type NumericSetting = Exclude<keyof LineArtSettings, 'textMode'>;

function syncSettingsUi() {
  for (const slider of sliders) {
    slider.value = String(settings.lineArt[slider.dataset.setting as NumericSetting]);
    slider.nextElementSibling!.textContent = slider.value;
  }
  $<HTMLInputElement>('#hide-text').checked = settings.lineArt.textMode === 'hide';
}

for (const slider of sliders) {
  slider.oninput = () => {
    settings.lineArt[slider.dataset.setting as NumericSetting] = Number(slider.value);
    slider.nextElementSibling!.textContent = slider.value;
    saveSettings();
    scheduleRerender();
  };
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
  button.onclick = () => {
    Object.assign(settings.lineArt, PRESETS[button.dataset.preset as PresetName]);
    syncSettingsUi();
    saveSettings();
    scheduleRerender();
  };
}

$<HTMLInputElement>('#hide-text').onchange = (e) => {
  settings.lineArt.textMode = (e.target as HTMLInputElement).checked ? 'hide' : 'edges';
  saveSettings();
  scheduleRerender();
};

// ---------- print wiring ----------

const paperSelect = $<HTMLSelectElement>('#paper');
const gapInput = $<HTMLInputElement>('#gap');
const cutLinesInput = $<HTMLInputElement>('#cut-lines');
paperSelect.value = settings.paper;
gapInput.value = String(settings.gap);
cutLinesInput.checked = settings.cutLines;
paperSelect.onchange = () => {
  settings.paper = paperSelect.value as Paper;
  saveSettings();
};
gapInput.onchange = () => {
  settings.gap = Math.max(0, Math.min(10, Number(gapInput.value) || 0));
  gapInput.value = String(settings.gap);
  saveSettings();
};
cutLinesInput.onchange = () => {
  settings.cutLines = cutLinesInput.checked;
  saveSettings();
};

$<HTMLButtonElement>('#download').onclick = async (e) => {
  const button = e.currentTarget as HTMLButtonElement;
  const images = cards.flatMap((card) => {
    if (card.copies === 0) return [];
    const image = { key: `card-${card.id}`, dataUrl: card.lineart.toDataURL('image/png') };
    return Array<typeof image>(card.copies).fill(image);
  });
  if (!images.length) {
    notify('Add at least one card (with 1 or more copies) first.');
    return;
  }
  button.disabled = true;
  button.textContent = 'Building PDF…';
  try {
    const blob = await buildPdf(images, { paper: settings.paper, gap: settings.gap, cutLines: settings.cutLines });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pokemon-coloring-cards.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (err) {
    notify(`Creating the PDF failed: ${(err as Error).message}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Download PDF';
  }
};

syncSettingsUi();
updateCount();
