import './style.css';
import { fetchDatabaseCard, parseDatabaseUrl, searchCards, type DatabaseRef, type SearchResult } from './database';
import { findArtRect, type Rect } from './detect';
import { decodeImage, fetchImage, nameFromUrl, parseUrls } from './import';
import { DEFAULT_LINE_ART, PRESETS, type LineArtSettings, type PresetName } from './lineart';
import { analyzeArt } from './coloring-client';
import { coloringParams, INKED_MIN } from './coloring';
import type { BackgroundMode } from './mask';
import { normalizeCard } from './normalize';
import { buildPdf, type Paper } from './pdf';
import { artImage, renderCard, type LayoutMode } from './render';
import {
  costToLetters,
  DEFAULT_STRUCTURE,
  ENERGY_TYPES,
  lettersToCost,
  type CardStructure,
  type EnergyType,
  type Stage,
} from './structure';

interface Settings {
  lineArt: LineArtSettings;
  layout: LayoutMode;
  background: BackgroundMode;
  /** Hide cards whose art is soft painted (no drawn lines): it doesn't give clean coloring lines. */
  hidePainted: boolean;
  paper: Paper;
  gap: number;
  cutLines: boolean;
  proxy: string;
}

/** Where a card's layout came from; "default" means nobody checked it yet. */
type StructureSource = 'database' | 'default' | 'edited';

interface Card {
  id: number;
  name: string;
  source: HTMLCanvasElement;
  art: Rect;
  structure: CardStructure;
  structureSource: StructureSource;
  /** Pokémon mask of the artwork; computed on demand when the background isn't kept. */
  foreground?: Uint8Array;
  /** Share of the Pokémon covered by ink lines (from the mask); below INKED_MIN the art is soft painted. */
  inkScore?: number;
  /** Coloring-book line art of the Pokémon, for the line settings in `key`. */
  coloring?: { key: string; lines: Uint8Array };
  output: HTMLCanvasElement;
  copies: number;
  el: HTMLElement;
}

const DEFAULT_SETTINGS: Settings = {
  lineArt: DEFAULT_LINE_ART,
  layout: 'template',
  background: 'fade',
  hidePainted: true,
  paper: 'a4',
  gap: 2,
  cutLines: true,
  proxy: '',
};
const STORAGE_KEY = 'pokemon-coloring:settings';
const SEARCH_PAGE = 48;

const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;

const settings = loadSettings();
const cards: Card[] = [];
let nextId = 1;

function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved) {
      const lineArt = { ...DEFAULT_LINE_ART };
      for (const key of Object.keys(lineArt) as (keyof LineArtSettings)[]) {
        if (typeof saved.lineArt?.[key] === 'number') lineArt[key] = saved.lineArt[key];
      }
      return { ...DEFAULT_SETTINGS, ...saved, lineArt };
    }
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
  if (kind === 'info') setTimeout(() => li.remove(), 6000);
}

// ---------- cards ----------

function render(card: Card) {
  const coloring = wantsColoring(card) ? card.coloring?.lines : undefined;
  renderCard(card.output, { ...card, coloring }, settings.lineArt, settings.layout, settings.background);
  // Until the lines for the current settings are ready, the previous ones are shown.
  if (wantsColoring(card) && card.coloring?.key !== coloringKey()) computeColoring([card]);
}

const isPainted = (card: Card) => card.inkScore !== undefined && card.inkScore < INKED_MIN;
const isHidden = (card: Card) => settings.hidePainted && isPainted(card);
const visibleCards = () => cards.filter((c) => !isHidden(c));

function updateVisibility() {
  for (const card of cards) card.el.hidden = isHidden(card);
  const hidden = cards.filter(isPainted).length;
  $('#painted-status').textContent = !hidden
    ? ''
    : settings.hidePainted
      ? `${hidden} card${hidden > 1 ? 's' : ''} hidden: painted art doesn’t give clean coloring lines.`
      : `${hidden} card${hidden > 1 ? 's have' : ' has'} painted art: the lines may come out messy.`;
  updateCount();
}

// ---------- background removal ----------

let maskQueue: Card[] = [];
let maskRunning = false;
let maskFailed = false;

/** Read through a function: the setting can change while masks are computed. */
const masksWanted = () => (settings.background !== 'keep' || settings.hidePainted) && !maskFailed;

function setBackgroundStatus(text: string) {
  $('#background-status').textContent = text;
}

/** Finds the Pokémon in each card's artwork, one card at a time, and re-renders it. */
async function computeMasks(newCards: Card[]) {
  if (!masksWanted()) return;
  maskQueue.push(...newCards.filter((c) => !c.foreground && !maskQueue.includes(c)));
  if (maskRunning) return;
  maskRunning = true;
  try {
    // Loaded on first use: the model runtime is large and not needed with "keep".
    const { foregroundMask } = await import('./segment');
    let done = 0;
    while (maskQueue.length && masksWanted()) {
      setBackgroundStatus(`Finding the Pokémon… ${done + 1}/${done + maskQueue.length}`);
      const card = maskQueue.shift()!;
      if (!cards.includes(card)) continue;
      card.foreground = await foregroundMask(artImage(card.source, card.art));
      done++;
      render(card);
      computeColoring([card]);
    }
    setBackgroundStatus('');
  } catch (err) {
    maskFailed = true;
    maskQueue = [];
    setBackgroundStatus('');
    notify(`Background removal is not available in this browser: ${(err as Error).message}`);
  } finally {
    maskRunning = false;
  }
}

// ---------- coloring-book line art ----------

let coloringQueue: Card[] = [];
let coloringRunning = false;

/** The coloring pipeline draws the Pokémon when the background is faded or removed, for inked art only. */
const wantsColoring = (card: Card) =>
  settings.layout === 'template' && settings.background !== 'keep' && !!card.foreground && !isPainted(card);
const coloringKey = () => JSON.stringify(coloringParams(settings.lineArt));

function setColoringStatus(text: string) {
  $('#coloring-status').textContent = text;
}

/** Computes each card's ink score (once) and coloring line art (per line settings) in a worker, one card at a time. */
async function computeColoring(newCards: Card[]) {
  const needed = (c: Card) => !!c.foreground && (c.inkScore === undefined || (wantsColoring(c) && c.coloring?.key !== coloringKey()));
  coloringQueue.push(...newCards.filter((c) => needed(c) && !coloringQueue.includes(c)));
  if (coloringRunning) return;
  coloringRunning = true;
  try {
    while (coloringQueue.length) {
      setColoringStatus(`Drawing coloring lines… ${coloringQueue.length} left`);
      const card = coloringQueue.shift()!;
      if (!cards.includes(card) || !needed(card)) continue;
      // Lines are computed with the first ink score too: most cards are inked.
      const key = coloringKey();
      const linesWanted = settings.layout === 'template' && settings.background !== 'keep' && !isPainted(card);
      const params = linesWanted ? coloringParams(settings.lineArt) : undefined;
      const result = await analyzeArt(artImage(card.source, card.art), card.foreground!, params);
      card.inkScore = result.inkScore;
      if (result.lines) card.coloring = { key, lines: result.lines };
      updateVisibility();
      render(card);
    }
  } catch (err) {
    coloringQueue = [];
    notify(`Drawing the coloring lines failed: ${(err as Error).message}`);
  } finally {
    coloringRunning = false;
    setColoringStatus('');
  }
}

function updateCount() {
  const shown = visibleCards();
  const total = shown.reduce((sum, c) => sum + c.copies, 0);
  $('#card-count').textContent = shown.length ? `(${shown.length} cards, ${total} to print)` : '';
  $('#empty-hint').hidden = cards.length > 0;
}

const SOURCE_LABELS: Record<StructureSource, string> = {
  database: '(from card database)',
  default: '(default — please check)',
  edited: '(edited)',
};

function fillEnergySelect(select: HTMLSelectElement) {
  select.append(new Option('none', ''));
  for (const t of ENERGY_TYPES) select.append(new Option(t, t));
}

/** Wires the per-card layout editor to `card.structure`. */
function setupStructureEditor(card: Card) {
  const el = card.el;
  const field = <T extends HTMLElement>(name: string) => el.querySelector<T>(`[data-field="${name}"]`)!;
  el.querySelectorAll<HTMLSelectElement>('.energy-select').forEach(fillEnergySelect);

  const sync = () => {
    const s = card.structure;
    field<HTMLSelectElement>('stage').value = s.stage;
    field<HTMLSelectElement>('type').value = s.type ?? '';
    field<HTMLInputElement>('abilities').value = String(s.abilities);
    field<HTMLInputElement>('retreat').value = String(s.retreat);
    field<HTMLSelectElement>('weakness').value = s.weakness ?? '';
    field<HTMLSelectElement>('resistance').value = s.resistance ?? '';
    field<HTMLInputElement>('attacks').value = s.attacks.map((a) => costToLetters(a.cost)).join(', ');
    el.querySelector('.structure-source')!.textContent = SOURCE_LABELS[card.structureSource];
    el.classList.toggle('unchecked', card.structureSource === 'default');
  };

  const clamp = (v: string, max: number) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  const energy = (v: string) => (v ? (v as EnergyType) : null);
  const update = () => {
    const previous = card.structure.attacks;
    card.structure = {
      stage: field<HTMLSelectElement>('stage').value as Stage,
      type: energy(field<HTMLSelectElement>('type').value),
      abilities: clamp(field<HTMLInputElement>('abilities').value, 2),
      retreat: clamp(field<HTMLInputElement>('retreat').value, 5),
      weakness: energy(field<HTMLSelectElement>('weakness').value),
      resistance: energy(field<HTMLSelectElement>('resistance').value),
      attacks: field<HTMLInputElement>('attacks')
        .value.split(',')
        .map((group) => lettersToCost(group))
        .filter((cost) => cost.length > 0)
        .slice(0, 4)
        // keep the damage box setting of attacks that already existed
        .map((cost, i) => ({ cost: cost.slice(0, 5), damage: previous[i]?.damage ?? true })),
    };
    card.structureSource = 'edited';
    sync();
    render(card);
  };

  el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]').forEach((input) => (input.onchange = update));
  sync();
}

function addCard(bitmap: ImageBitmap, name: string, structure: CardStructure | null) {
  const image = normalizeCard(bitmap);
  bitmap.close();
  const el = ($<HTMLTemplateElement>('#card-template').content.firstElementChild as HTMLElement).cloneNode(
    true,
  ) as HTMLElement;
  const source = el.querySelector<HTMLCanvasElement>('canvas.original')!;
  source.width = image.width;
  source.height = image.height;
  source.getContext('2d', { willReadFrequently: true })!.putImageData(image, 0, 0);

  const card: Card = {
    id: nextId++,
    name,
    source,
    art: findArtRect(image),
    structure: structure ?? structuredClone(DEFAULT_STRUCTURE),
    structureSource: structure ? 'database' : 'default',
    output: el.querySelector<HTMLCanvasElement>('canvas.output')!,
    copies: 1,
    el,
  };
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
    updateVisibility();
  };
  setupStructureEditor(card);

  render(card);
  cards.push(card);
  $('#card-grid').append(el);
  updateCount();
  computeMasks([card]);
}

async function addFromBlob(blob: Blob, name: string, structure: CardStructure | null = null) {
  try {
    addCard(await decodeImage(blob), name, structure);
  } catch (err) {
    notify(`Could not add “${name}”: ${(err as Error).message}`);
  }
}

async function addFromDatabase(ref: DatabaseRef): Promise<boolean> {
  try {
    const card = await fetchDatabaseCard(ref);
    const blob = await fetchImage(card.imageUrl, settings.proxy);
    await addFromBlob(blob, `${card.name} (${card.id})`, card.structure);
    return true;
  } catch (err) {
    notify(`Could not load card ${ref.id} from the card database: ${(err as Error).message}`);
    return false;
  }
}

async function addFromUrls(urls: string[]) {
  for (const url of urls) {
    const ref = parseDatabaseUrl(url);
    if (ref && (await addFromDatabase(ref))) continue;
    // Plain image link, or the database is unavailable: image only, default layout.
    const name = nameFromUrl(url);
    try {
      await addFromBlob(await fetchImage(url, settings.proxy), name);
      notify(`“${name}” has no card data — check its layout under “Layout”.`, 'info');
    } catch (err) {
      notify(`Could not load “${name}”: ${(err as Error).message}`);
    }
  }
}

async function addFiles(files: Iterable<File>) {
  let added = 0;
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      await addFromBlob(file, file.name);
      added++;
    } else {
      notify(`Skipped “${file.name}”: not an image.`);
    }
  }
  if (added) notify('Uploaded images have no card data — check each card’s layout under “Layout”.', 'info');
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
      render(card);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, 150);
}

// ---------- search ----------

let searchResults: SearchResult[] = [];
let searchShown = 0;

function showSearchResults() {
  const container = $('#search-results');
  for (const result of searchResults.slice(searchShown, searchShown + SEARCH_PAGE)) {
    const button = document.createElement('button');
    button.className = 'search-result';
    button.title = `Add ${result.name} (${result.id})`;
    const img = document.createElement('img');
    img.src = `${result.image}/low.webp`;
    img.alt = result.name;
    img.loading = 'lazy';
    const caption = document.createElement('span');
    caption.textContent = `${result.name} · ${result.id}`;
    button.append(img, caption);
    button.onclick = async () => {
      button.disabled = true;
      button.classList.add('loading');
      const ok = await addFromDatabase({ db: 'tcgdex', id: result.id });
      button.classList.remove('loading');
      button.classList.toggle('added', ok);
      button.disabled = false;
    };
    container.append(button);
  }
  searchShown = Math.min(searchResults.length, searchShown + SEARCH_PAGE);
  $('#search-more').hidden = searchShown >= searchResults.length;
}

$<HTMLFormElement>('#search-form').onsubmit = async (e) => {
  e.preventDefault();
  const query = $<HTMLInputElement>('#search-input').value.trim();
  if (!query) return;
  const status = $('#search-status');
  status.textContent = 'Searching…';
  $('#search-results').replaceChildren();
  $('#search-more').hidden = true;
  try {
    searchResults = await searchCards(query);
    searchShown = 0;
    status.textContent = searchResults.length
      ? `${searchResults.length} cards found — click cards to add them.`
      : `No cards found for “${query}”. Check the spelling (English names).`;
    showSearchResults();
  } catch (err) {
    status.textContent = `Search failed: ${(err as Error).message}. Please try again.`;
  }
};
$('#search-more').onclick = showSearchResults;

// ---------- other import wiring ----------

$<HTMLInputElement>('#file-input').onchange = async (e) => {
  const input = e.target as HTMLInputElement;
  await addFiles(input.files ?? []);
  input.value = '';
};

$('#url-add').onclick = async () => {
  const textarea = $<HTMLTextAreaElement>('#url-input');
  const urls = parseUrls(textarea.value);
  if (!urls.length) {
    notify('Please paste at least one link (starting with http:// or https://).');
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
    notify('Pasted images have no card data — check the layout under “Layout”.', 'info');
    return;
  }
  // Pasting links outside text fields adds them directly.
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

function syncSettingsUi() {
  for (const slider of sliders) {
    slider.value = String(settings.lineArt[slider.dataset.setting as keyof LineArtSettings]);
    slider.nextElementSibling!.textContent = slider.value;
  }
  $<HTMLSelectElement>('#layout-mode').value = settings.layout;
  $<HTMLSelectElement>('#background').value = settings.background;
  $<HTMLInputElement>('#hide-painted').checked = settings.hidePainted;
}

for (const slider of sliders) {
  slider.oninput = () => {
    settings.lineArt[slider.dataset.setting as keyof LineArtSettings] = Number(slider.value);
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

$<HTMLSelectElement>('#layout-mode').onchange = (e) => {
  settings.layout = (e.target as HTMLSelectElement).value as LayoutMode;
  saveSettings();
  scheduleRerender();
};

$<HTMLSelectElement>('#background').onchange = (e) => {
  settings.background = (e.target as HTMLSelectElement).value as BackgroundMode;
  saveSettings();
  scheduleRerender();
  computeMasks(cards);
};

$<HTMLInputElement>('#hide-painted').onchange = (e) => {
  settings.hidePainted = (e.target as HTMLInputElement).checked;
  saveSettings();
  updateVisibility();
  computeMasks(cards);
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
  const images = visibleCards().flatMap((card) => {
    if (card.copies === 0) return [];
    const image = { key: `card-${card.id}`, dataUrl: card.output.toDataURL('image/png') };
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
