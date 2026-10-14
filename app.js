/* Static CATAAS gallery. API access, session state, rendering, then events. */
(() => {
  'use strict';
  const API = 'https://cataas.com', PAGE_SIZE = 6, STORAGE = 'neko.favorites.v1';
  const IMAGE_CONCURRENCY = 3, IMAGE_TIMEOUT = 12000;
  let navigating = false, renderedCats = null;
  const $ = id => document.getElementById(id);
  const state = { view: 'all', tag: '', pages: [], page: 0, offset: 0, ended: false, seen: new Set(), cats: [], busy: false, generation: 0, controller: null, tags: null, tagLimit: 40, favorites: new Map(), viewerIndex: 0, focus: null };
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function button(text, action, key) {
    const node = element('button', text); node.type = 'button'; node.dataset.action = action;
    if (key) node.dataset.key = key; return node;
  }
  function normalizeCat(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof (raw.id ?? raw._id) === 'string' ? (raw.id ?? raw._id) : '';
    let url;
    if (/^[a-zA-Z0-9_-]+$/.test(id)) url = `${API}/cat/${encodeURIComponent(id)}`;
    else {
      try {
        const parsed = new URL(raw.url);
        if (parsed.origin !== API || !/^\/cat\/[a-zA-Z0-9_-]+$/.test(parsed.pathname)) return null;
        url = parsed.origin + parsed.pathname;
      } catch { return null; }
    }
    return { id, url, key: id || url, tags: Array.isArray(raw.tags) ? [...new Set(raw.tags.filter(t => typeof t === 'string' && t.length <= 120))].slice(0, 30) : [] };
  }
  async function request(url, signal, blob = false, timeout = 12000) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeout);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      if (blob && !response.headers.get('content-type')?.startsWith('image/')) throw new Error('Not an image');
      return blob ? await response.blob() : await response.json();
    } catch (error) {
      if (!signal?.aborted && controller.signal.aborted) {
        const timedOut = new Error('Request timed out'); timedOut.retryable = true; throw timedOut;
      }
      if (error instanceof TypeError) error.retryable = true;
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  function backoff(signal, attempt) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('Cancelled')); return; }
      const abort = () => { clearTimeout(timer); reject(new Error('Cancelled')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 250 * 2 ** attempt + Math.random() * 150);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  async function recoverRequest(url, signal, blob = false, timeout = 12000) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await request(url, signal, blob, timeout); }
      catch (error) {
        if (signal?.aborted || !error.retryable || attempt === 1) throw error;
        await backoff(signal, attempt);
      }
    }
  }
  let noticeTimer;
  function notify(text) { $('notice').textContent = text; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').textContent = ''; }, 6000); }
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) || '[]');
    if (Array.isArray(saved)) saved.slice(0, 1000).forEach(raw => { const cat = normalizeCat(raw); if (cat) state.favorites.set(cat.key, cat); });
  } catch { notify('Saved favorites could not be read. You can still collect cats this session.'); }
  function persist() {
    try { localStorage.setItem(STORAGE, JSON.stringify([...state.favorites.values()].map(({ id, url, tags }) => ({ id, url, tags })))); }
    catch { notify('Favorites are available this session, but this browser could not save them.'); }
  }
  function favorite(cat) {
    if (state.favorites.has(cat.key)) state.favorites.delete(cat.key); else state.favorites.set(cat.key, cat);
    persist(); syncFavorites();
    if (state.view === 'favorites') {
      const selected = state.cats[state.viewerIndex]?.key;
      state.cats = [...state.favorites.values()]; render();
      if ($('viewer').open) {
        if (!state.cats.length) $('viewer').close();
        else { state.viewerIndex = Math.max(0, state.cats.findIndex(c => c.key === selected)); renderViewer(); }
      }
    }
  }
  function syncFavorites() {
    $('favoriteCount').textContent = state.favorites.size;
    document.querySelectorAll('[data-action="favorite"]').forEach(node => {
      const saved = state.favorites.has(node.dataset.key);
      node.textContent = saved ? '♥ Remove favorite' : '♡ Save favorite'; node.setAttribute('aria-pressed', saved);
    });
    if ($('viewer').open) {
      const saved = state.favorites.has(state.cats[state.viewerIndex]?.key);
      $('viewerFavorite').textContent = saved ? '♥ Remove favorite' : '♡ Save favorite'; $('viewerFavorite').setAttribute('aria-pressed', saved);
    }
  }
  // Bound image traffic separately from metadata requests. Cache only successful
  // blobs, with both an entry limit and a byte limit (no persistent image files).
  const imageQueue = [], imageCache = new Map();
  let activeImages = 0, cachedBytes = 0;
  function cacheImage(url, blob) {
    if (blob.size > 8 * 1024 * 1024) return;
    if (imageCache.has(url)) return;
    imageCache.set(url, blob); cachedBytes += blob.size;
    while (imageCache.size > 12 || cachedBytes > 16 * 1024 * 1024) {
      const oldest = imageCache.keys().next().value;
      cachedBytes -= imageCache.get(oldest).size; imageCache.delete(oldest);
    }
  }
  function drainImages() {
    while (activeImages < IMAGE_CONCURRENCY && imageQueue.length) {
      const job = imageQueue.shift();
      if (job.signal.aborted) continue;
      activeImages++;
      job.run().finally(() => { activeImages--; drainImages(); });
    }
  }
  const unavailableImages = new Map();
  function galleryPreviewWidth() {
    const columns = window.innerWidth >= 992 ? 3 : window.innerWidth >= 768 ? 2 : 1;
    const width = Math.max(240, $('contentArea').clientWidth / columns - 24);
    return Math.min(640, Math.ceil(width * Math.min(window.devicePixelRatio || 1, 1.5) / 80) * 80);
  }
  function disposeMedia(root) {
    root.querySelectorAll('.media').forEach(node => node.dispose?.());
  }
  function updateImageStatus() {
    if (state.busy || state.view === 'favorites') return;
    const cards = [...$('contentArea').querySelectorAll('.media')];
    if (!cards.length) return;
    const ready = cards.filter(node => node.classList.contains('ready')).length;
    const failed = cards.filter(node => node.classList.contains('failed')).length;
    $('statusText').textContent = `${ready} of ${cards.length} pictures ready${failed ? `; ${failed} unavailable — use Retry image` : ''}.`;
  }
  // One queue owns network fetches because HTTP status is needed for safe retry.
  // Only visible cards (plus the primary card) fetch; the displayed img confirms
  // decoding directly. No hidden probe and no second download/validation pass.
  function media(cat, large = false, index = 0, original = false, manual = false) {
    const wrap = element('div', undefined, 'media pending');
    const host = large ? element('div') : button('', 'open', cat.key);
    host.className = 'image-open';
    if (!large) host.setAttribute('aria-label', 'Open cat image in larger viewer');
    const img = element('img');
    img.alt = cat.tags.length ? `Cat tagged ${cat.tags.join(', ')}` : 'Cat photograph';
    img.width = 480; img.height = 360; img.decoding = 'async';
    img.loading = large || index === 0 ? 'eager' : 'lazy';
    if (large || index === 0) img.fetchPriority = 'high';
    cat.previewWidth ||= galleryPreviewWidth();
    const url = original ? cat.url : `${cat.url}?width=${large ? 1200 : cat.previewWidth}`;
    const controller = new AbortController();
    let observer, timer, objectUrl, disposed = false, queued = false, finished = false, finishReady;
    wrap.ready = new Promise(resolve => { finishReady = resolve; });
    const settle = loaded => { if (!finished) { finished = true; finishReady(loaded); } };
    wrap.dispose = () => {
      disposed = true; controller.abort(); observer?.disconnect(); clearTimeout(timer);
      img.onload = null; img.onerror = null; img.removeAttribute('src');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      settle(false);
    };
    const fail = () => {
      if (disposed || finished) return;
      controller.abort(); clearTimeout(timer); img.onload = null; img.onerror = null;
      img.removeAttribute('src');
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
      unavailableImages.set(url, Date.now() + 60000);
      if (unavailableImages.size > 100) unavailableImages.delete(unavailableImages.keys().next().value);
      wrap.className = 'media failed';
      const retry = button('Retry image', 'retry-image', cat.key);
      retry.dataset.original = String(original);
      wrap.replaceChildren(element('p', 'This picture could not load. Try again when the service is available.'), retry);
      settle(false); updateImageStatus();
    };
    async function run() {
      if (disposed) return;
      wrap.className = 'media loading';
      // Allows two 12-second network attempts plus backoff and image decode.
      timer = setTimeout(fail, IMAGE_TIMEOUT * 2 + 3000);
      try {
        if (!manual && !imageCache.has(url) && (unavailableImages.get(url) || 0) > Date.now()) { fail(); return; }
        const blob = imageCache.get(url) || await recoverRequest(url, controller.signal, true, IMAGE_TIMEOUT);
        if (disposed || controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        await new Promise((resolve, reject) => {
          const abort = () => reject(new Error('Image cancelled'));
          controller.signal.addEventListener('abort', abort, { once: true });
          const complete = callback => {
            controller.signal.removeEventListener('abort', abort);
            img.onload = null; img.onerror = null; callback();
          };
          img.onload = () => complete(resolve);
          img.onerror = () => complete(() => reject(new Error('Image decode failed')));
          img.src = objectUrl;
        });
        if (disposed || controller.signal.aborted) return;
        clearTimeout(timer); cacheImage(url, blob); unavailableImages.delete(url);
        wrap.className = 'media ready'; settle(true); updateImageStatus();
      } catch { fail(); }
    }
    function enqueue() {
      if (queued || disposed) return;
      queued = true; observer?.disconnect(); wrap.className = 'media queued';
      if (imageCache.has(url)) { run(); return; }
      const job = { signal: controller.signal, run };
      if (large || index === 0) imageQueue.unshift(job); else imageQueue.push(job);
      drainImages();
    }
    host.append(img); wrap.append(host);
    if (large || index === 0 || manual) enqueue();
    else if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) enqueue();
      }, { rootMargin: '0px' });
      observer.observe(wrap);
    } else enqueue();
    return wrap;
  }
  function loadingStructure() {
    if (state.cats.length) return;
    const contents = $('contentArea'); disposeMedia(contents); contents.replaceChildren();
    for (let index = 0; index < PAGE_SIZE; index++) {
      const col = element('div', undefined, 'col-12 col-md-6 col-lg-4');
      const card = element('div', undefined, 'cat-card skeleton'); card.setAttribute('aria-hidden', 'true');
      card.append(element('div', undefined, 'media loading'), element('div', 'Finding a cat…', 'card-copy'));
      col.append(card); contents.append(col);
    }
    renderedCats = null;
  }
  function render() {
    const contents = $('contentArea');
    if (renderedCats !== state.cats) {
      disposeMedia(contents); contents.replaceChildren(); renderedCats = state.cats;
      state.cats.forEach((cat, index) => {
        const col = element('div', undefined, 'col-12 col-md-6 col-lg-4');
        const card = element('article', undefined, 'cat-card'); card.append(media(cat, false, index));
        const copy = element('div', undefined, 'card-copy'); copy.append(element('p', cat.tags.join(' · ') || 'An untagged little friend', 'cat-tags'));
        const actions = element('div', undefined, 'card-actions'); actions.append(button('♡ Save favorite', 'favorite', cat.key), button('Download ↓', 'download', cat.key)); copy.append(actions); card.append(copy); col.append(card); contents.append(col);
      });
      if (!state.cats.length && !state.busy) contents.append(element('p', state.view === 'favorites' ? 'Your collection starts with a smile. Use ♡ on any cat to save it here.' : ($('retryRequest').hidden ? 'No cats found. Try another tag or clear the filter.' : 'New cats are unavailable right now. Retry above or visit your favorites.'), 'empty'));
    }
    $('collectionTitle').textContent = state.view === 'favorites' ? 'Your favorites' : state.view === 'random' ? 'A random little friend' : state.tag ? `Cats tagged “${state.tag}”` : 'All cats';
    $('imageCount').textContent = `${state.cats.length} ${state.cats.length === 1 ? 'cat' : 'cats'}`;
    $('pagerNav').hidden = state.view === 'favorites' || state.view === 'random';
    $('pageText').textContent = `Page ${state.page + 1}`;
    $('prevPage').disabled = state.busy || state.page === 0;
    $('nextPage').disabled = state.busy || navigating || (state.ended && state.page === state.pages.length - 1);
    $('nextCatBtn').disabled = state.busy;
    contents.setAttribute('aria-busy', state.busy);
    document.querySelectorAll('[data-view]').forEach(node => node.setAttribute('aria-pressed', node.dataset.view === state.view));
    $('clearBtn').disabled = !state.tag; syncFavorites();
  }
  function updateBusy() {
    $('contentArea').setAttribute('aria-busy', state.busy);
    if (state.busy) $('contentArea').querySelector('.empty')?.remove();
    $('prevPage').disabled = state.busy || state.page === 0;
    $('nextPage').disabled = state.busy || navigating || (state.ended && state.page === state.pages.length - 1);
    $('nextCatBtn').disabled = state.busy;
  }
  function reset(view, tag = '') {
    if ($('viewer').open) $('viewer').close();
    state.controller?.abort(); state.generation++; state.busy = false;
    Object.assign(state, { view, tag, pages: [], page: 0, offset: 0, ended: false, seen: new Set(), cats: [] });
    $('searchInput').value = tag; $('statusText').textContent = ''; $('retryRequest').hidden = true;
    $('tagsPanel').hidden = view !== 'tags'; navigating = false; render();
  }
  async function loadPage(random = false) {
    if (state.busy) return null;
    const generation = state.generation;
    const controller = new AbortController(); state.controller = controller; state.busy = true;
    $('statusText').textContent = 'Loading cat details…'; $('retryRequest').hidden = true;
    loadingStructure(); updateBusy();
    const found = [], keys = new Set(state.seen);
    let offset = state.offset, ended = false, selected = null, selectedPage = state.page;
    try {
      // Small metadata batches only; image jobs belong to the cards themselves.
      for (let attempt = 0; attempt < (random ? 3 : 2) && found.length < (random ? 1 : PAGE_SIZE); attempt++) {
        let records;
        if (random) records = [await recoverRequest(`${API}/cat${state.tag ? '/' + encodeURIComponent(state.tag) : ''}?json=true`, controller.signal)];
        else {
          const url = new URL(`${API}/api/cats`);
          url.searchParams.set('limit', PAGE_SIZE - found.length); url.searchParams.set('skip', offset);
          if (state.tag) url.searchParams.set('tags', state.tag);
          records = await recoverRequest(url, controller.signal);
          if (!Array.isArray(records)) throw new Error('Invalid cat list');
          offset += records.length; if (!records.length) { ended = true; break; }
        }
        records.forEach(raw => {
          const cat = normalizeCat(raw);
          if (cat && !keys.has(cat.key)) { keys.add(cat.key); found.push(cat); }
        });
      }
      if (generation !== state.generation) return null;
      state.offset = offset; state.ended = ended;
      if (found.length) {
        state.seen = keys; state.cats = found; selected = found;
        if (!random) { state.pages.push(found); state.page = state.pages.length - 1; }
        selectedPage = state.page;
        $('statusText').textContent = 'Cat details ready. Pictures load independently as you browse.';
      } else {
        $('statusText').textContent = ended ? (state.cats.length ? 'End of available results. Your current pictures are still here.' : 'No matching cats available.') : 'No new unique cats found. Try again or choose another tag.';
        $('retryRequest').hidden = ended;
        if (!state.cats.length) renderedCats = null;
      }
    } catch {
      if (generation !== state.generation) return null;
      $('statusText').textContent = 'CATAAS could not return cat details. Retry; your current pictures and favorites are still available.';
      $('retryRequest').hidden = false; if (!state.cats.length) renderedCats = null;
    } finally {
      if (generation === state.generation) { state.busy = false; render(); }
    }
    if (!selected) return null;
    // Pagination scroll waits for the primary card's load/error state, not a
    // whole batch. Other cards and the rest of the interface remain independent.
    await $('contentArea').querySelector('.media')?.ready;
    return { cats: selected, page: selectedPage };
  }
  async function loadTags() {
    if (state.tags) { renderTags(); return; }
    if (loadTags.pending) return;
    loadTags.pending = true; $('tagStatus').textContent = 'Loading available tags…'; $('retryTags').hidden = true;
    try {
      const raw = await request(`${API}/api/tags`);
      if (!Array.isArray(raw)) throw new Error('Invalid tags');
      state.tags = [...new Set(raw.filter(t => typeof t === 'string' && t.trim() && t.length <= 120))].sort((a,b) => a.localeCompare(b)); renderTags();
    } catch { $('tagStatus').textContent = 'Tags are unavailable. You can still search by tag.'; $('retryTags').hidden = false; }
    finally { loadTags.pending = false; }
  }
  function renderTags() {
    const query = $('tagSearch').value.trim().toLowerCase(); const matches = (state.tags || []).filter(tag => tag.toLowerCase().includes(query));
    $('tagList').replaceChildren(); const all = button('All Cats', 'tag'); all.dataset.tag = ''; all.setAttribute('aria-pressed', !state.tag); $('tagList').append(all);
    matches.slice(0, state.tagLimit).forEach(tag => { const node = button(tag, 'tag'); node.dataset.tag = tag; node.setAttribute('aria-pressed', tag === state.tag); $('tagList').append(node); });
    $('tagStatus').textContent = `${matches.length} available tags${matches.length ? '' : ' — try a different tag search'}.`; $('moreTags').hidden = matches.length <= state.tagLimit;
  }
  function filter(tag, view = 'all') {
    tag = tag.trim(); // Preserve API tag case; tag filtering can be case-sensitive.
    if (state.tag === tag && state.view === view && (state.busy || state.pages.length)) return;
    reset(view, tag); if (view === 'tags') { loadTags(); if (state.tags) renderTags(); } loadPage();
  }
  function renderViewer() {
    const cat = state.cats[state.viewerIndex]; if (!cat) return;
    disposeMedia($('viewerMedia')); $('viewerMedia').replaceChildren(media(cat, true)); $('viewerTags').textContent = cat.tags.join(' · ') || 'No tags available';
    $('viewerTitle').textContent = `Cat ${state.viewerIndex + 1} of ${state.cats.length}`;
    $('viewerPrev').disabled = state.viewerIndex === 0; $('viewerNext').disabled = state.viewerIndex >= state.cats.length - 1; syncFavorites();
  }
  function openViewer(cat, trigger) { state.viewerIndex = state.cats.findIndex(c => c.key === cat.key); state.focus = trigger; renderViewer(); $('viewer').append($('notice'), $('downloadFallback')); $('viewer').showModal(); document.body.classList.add('viewer-open'); syncFavorites(); }
  const downloading = new Set();
  async function download(cat, trigger) {
    if (downloading.has(cat.key)) return; downloading.add(cat.key); trigger.disabled = true; notify('Preparing original image…');
    try {
      const blob = await request(cat.url, undefined, true); const url = URL.createObjectURL(blob);
      const link = element('a'); link.href = url; const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' })[blob.type] || 'img';
      link.download = `neko-${cat.id || cat.url.split('/').pop()}.${ext}`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); notify('Download requested. Check your browser’s downloads.');
    } catch { $('originalLink').href = cat.url; $('downloadFallback').hidden = false; notify('The original could not be downloaded. Use the save-through-browser link.'); }
    finally { downloading.delete(cat.key); trigger.disabled = false; }
  }
  function delegated(event) {
    const node = event.target.closest('button[data-action]'); if (!node) return;
    if (node.dataset.action === 'tag') { filter(node.dataset.tag, node.dataset.tag ? 'tags' : 'all'); return; }
    const cat = state.cats.find(c => c.key === node.dataset.key); if (!cat) return;
    if (node.dataset.action === 'open') openViewer(cat, node);
    if (node.dataset.action === 'favorite') favorite(cat);
    if (node.dataset.action === 'download') download(cat, node);
    if (node.dataset.action === 'retry-image') {
      const previous = node.closest('.media'); previous.dispose?.();
      previous.replaceWith(media(cat, !!node.closest('dialog'), 0, node.dataset.original === 'true', true));
    }
  }
  $('contentArea').addEventListener('click', delegated); $('tagsPanel').addEventListener('click', delegated); $('viewerMedia').addEventListener('click', delegated);
  document.querySelector('.view-nav').addEventListener('click', event => {
    const node = event.target.closest('[data-view]'); if (!node) return;
    if (node.dataset.view === 'favorites') { reset('favorites'); state.cats = [...state.favorites.values()]; render(); }
    else if (node.dataset.view === 'tags') { if (state.view !== 'all' && state.view !== 'tags') filter(state.tag, 'tags'); else { state.view = 'tags'; $('tagsPanel').hidden = false; render(); } loadTags(); }
    else filter('');
  });
  $('searchForm').addEventListener('submit', event => { event.preventDefault(); filter($('searchInput').value, state.view === 'tags' ? 'tags' : 'all'); });
  $('clearBtn').addEventListener('click', () => filter(''));
  $('nextCatBtn').addEventListener('click', () => { if (state.view !== 'random') { const tag = state.tag, seen = state.seen; reset('random', tag); state.seen = seen; } loadPage(true); });
  function scrollToGallery() {
    const heading = document.querySelector('.gallery-heading');
    const navigation = document.querySelector('.view-nav');
    const cover = document.querySelector('.site-header').getBoundingClientRect().height + navigation.getBoundingClientRect().height + 16;
    window.scrollTo({ top: Math.max(0, heading.getBoundingClientRect().top + window.scrollY - cover), behavior: 'instant' });
    $('collectionTitle').focus({ preventScroll: true });
  }
  $('prevPage').addEventListener('click', () => {
    if (!state.busy && state.page > 0) {
      state.cats = state.pages[--state.page]; $('statusText').textContent = 'Previously viewed page.';
      render(); scrollToGallery();
    }
  });
  $('nextPage').addEventListener('click', async () => {
    if (state.busy || navigating || (state.ended && state.page === state.pages.length - 1)) return;
    navigating = true; updateBusy();
    const generation = state.generation;
    let selected = null;
    try {
      if (state.page < state.pages.length - 1) {
        state.cats = state.pages[++state.page]; render();
        selected = { cats: state.cats, page: state.page };
        await $('contentArea').querySelector('.media')?.ready;
      } else selected = await loadPage();
      if (selected && generation === state.generation && selected.cats === state.cats && selected.page === state.page) scrollToGallery();
    } finally { if (generation === state.generation) { navigating = false; updateBusy(); } }
  });
  $('retryRequest').addEventListener('click', () => loadPage(state.view === 'random'));
  $('tagSearch').addEventListener('input', () => { state.tagLimit = 40; renderTags(); }); $('moreTags').addEventListener('click', () => { state.tagLimit += 40; renderTags(); }); $('retryTags').addEventListener('click', loadTags);
  $('closeViewer').addEventListener('click', () => $('viewer').close());
  $('viewer').addEventListener('click', event => { if (event.target === $('viewer')) { const r = $('viewer').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('viewer').close(); } });
  $('viewer').addEventListener('close', () => { disposeMedia($('viewerMedia')); document.body.append($('notice'), $('downloadFallback')); document.body.classList.remove('viewer-open'); if (state.focus?.isConnected) state.focus.focus(); else document.querySelector('[data-view="favorites"]').focus(); });
  function moveViewer(direction) { const next = state.viewerIndex + direction; if (next >= 0 && next < state.cats.length) { state.viewerIndex = next; renderViewer(); } }
  $('viewerPrev').addEventListener('click', () => moveViewer(-1)); $('viewerNext').addEventListener('click', () => moveViewer(1));
  $('viewer').addEventListener('keydown', event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); moveViewer(event.key === 'ArrowLeft' ? -1 : 1); } });
  $('viewerFavorite').addEventListener('click', () => favorite(state.cats[state.viewerIndex])); $('viewerDownload').addEventListener('click', event => download(state.cats[state.viewerIndex], event.currentTarget));
  $('dismissFallback').addEventListener('click', () => { $('downloadFallback').hidden = true; });
  const header = document.querySelector('.site-header');
  const updateHeaderHeight = () => document.documentElement.style.setProperty('--header-height', `${header.getBoundingClientRect().height}px`);
  updateHeaderHeight();
  if ('ResizeObserver' in window) new ResizeObserver(updateHeaderHeight).observe(header);
  else window.addEventListener('resize', updateHeaderHeight);
  loadPage();
})();


