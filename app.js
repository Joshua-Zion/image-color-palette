(() => {
  'use strict';

  const STORAGE_KEY = 'local-color-palettes:v1';
  const SAMPLE_NAME = '苔原河谷.jpg';
  const MAX_STORED_PALETTES = 100;
  const PREVIEW_COLUMNS_BASE = 8;
  const PREVIEW_COLUMNS_RANGE = 16;

  const FORMAT_META = {
    css: {
      ext: 'css',
      mime: 'text/css;charset=utf-8',
      label: 'CSS 变量',
      toastLabel: 'CSS',
    },
    json: {
      ext: 'json',
      mime: 'application/json;charset=utf-8',
      label: 'JSON 数据',
      toastLabel: 'JSON',
    },
    gpl: {
      ext: 'gpl',
      mime: 'text/plain;charset=utf-8',
      label: 'GIMP 色板',
      toastLabel: 'GPL',
    },
    ase: {
      ext: 'ase',
      mime: 'application/octet-stream',
      label: 'Adobe 色板',
      toastLabel: 'ASE',
    },
  };

  const $ = (selector, root = document) => root.querySelector(selector);

  const refs = {
    preview: $('#preview'),
    previewCanvas: $('#previewCanvas'),
    emptyState: $('#emptyState'),
    previewActions: $('#previewActions'),
    previewLoading: $('#previewLoading'),
    loadingLabel: $('#loadingLabel'),
    fileInput: $('#fileInput'),
    pickButton: $('#pickButton'),
    changeButton: $('#changeButton'),
    viewOriginalButton: $('#viewOriginalButton'),
    precision: $('#precision'),
    precisionValue: $('#precisionValue'),
    paletteGrid: $('#paletteGrid'),
    paletteMeta: $('#paletteMeta'),
    exportButton: $('#exportButton'),
    saveButton: $('#saveButton'),
    libraryButton: $('#libraryButton'),
    libraryBadge: $('#libraryBadge'),
    libraryDialog: $('#libraryDialog'),
    libraryList: $('#libraryList'),
    libraryFoot: $('#libraryFoot'),
    exportDialog: $('#exportDialog'),
    exportSubtitle: $('#exportSubtitle'),
    exportStrip: $('#exportStrip'),
    formatList: $('#formatList'),
    imageDialog: $('#imageDialog'),
    lightboxImage: $('#lightboxImage'),
    lightboxTitle: $('#lightboxTitle'),
    toast: $('#toast'),
    toastIconUse: $('#toastIcon use'),
    toastMessage: $('#toastMessage'),
    toastAction: $('#toastAction'),
  };

  const state = {
    image: null,
    imageSrc: '',
    imageName: '',
    objectUrl: null,
    loadToken: 0,
    extractionSeq: 0,
    extractionTimer: 0,
    points: null,
    palette: [],
    paletteRequestedK: 0,
    precision: Number(refs.precision.value) || 75,
    paletteBusy: false,
    loading: false,
    saved: [],
    exportPayload: null,
    toastTimer: 0,
    toastActionHandler: null,
    copiedTimers: new WeakMap(),
    deleteTimer: 0,
    dragDepth: 0,
  };

  function init() {
    state.saved = loadSavedPalettes();
    state.precision = clamp(Number(refs.precision.value) || 75, 10, 100);
    updatePrecisionUI();
    updateLibraryBadge();
    renderSkeletons(estimatePaletteCount());
    bindEvents();
    watchPreviewResize();
    syncActionAvailability();

    if (typeof window.SAMPLE_IMAGE === 'string' && window.SAMPLE_IMAGE.length > 0) {
      loadSource(window.SAMPLE_IMAGE, {
        name: SAMPLE_NAME,
        objectUrl: null,
      });
    } else {
      resetToEmptyState();
    }
  }

  function bindEvents() {
    refs.pickButton.addEventListener('click', (event) => {
      event.stopPropagation();
      openFilePicker();
    });
    refs.changeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      openFilePicker();
    });
    refs.viewOriginalButton.addEventListener('click', (event) => {
      event.stopPropagation();
      openLightbox();
    });
    refs.fileInput.addEventListener('click', (event) => event.stopPropagation());
    refs.fileInput.addEventListener('change', handleFileInput);
    refs.preview.addEventListener('click', handlePreviewClick);
    refs.preview.addEventListener('dragenter', handleDragEnter);
    refs.preview.addEventListener('dragover', handleDragOver);
    refs.preview.addEventListener('dragleave', handleDragLeave);
    refs.preview.addEventListener('drop', handleDrop);
    window.addEventListener('dragend', resetDragState);
    window.addEventListener('blur', resetDragState);
    refs.precision.addEventListener('input', handlePrecisionInput);
    refs.paletteGrid.addEventListener('click', handlePaletteClick);
    refs.saveButton.addEventListener('click', savePalette);
    refs.exportButton.addEventListener('click', () => {
      if (!state.palette.length) return;
      openExportDialog(generatePaletteName(state.palette), state.palette);
    });
    refs.libraryButton.addEventListener('click', openLibrary);
    refs.libraryList.addEventListener('click', handleLibraryAction);
    refs.formatList.addEventListener('click', handleFormatSelection);
    refs.toastAction.addEventListener('click', () => {
      const handler = state.toastActionHandler;
      hideToast();
      if (typeof handler === 'function') handler();
    });
    document.addEventListener('paste', handlePaste);
    document.querySelectorAll('[data-close-dialog]').forEach((button) => {
      button.addEventListener('click', () => {
        const dialog = button.closest('dialog');
        if (dialog) dialog.close();
      });
    });
    [refs.libraryDialog, refs.exportDialog, refs.imageDialog].forEach((dialog) => {
      dialog.addEventListener('click', handleSheetBackdropClick);
    });
    refs.libraryDialog.addEventListener('close', resetDeleteConfirmation);
  }

  /* Image loading */

  function openFilePicker() {
    refs.fileInput.click();
  }

  function handleFileInput() {
    const file = refs.fileInput.files && refs.fileInput.files[0];
    refs.fileInput.value = '';
    if (file) openImageFile(file);
  }

  async function openImageFile(file) {
    if (!isImageFile(file)) {
      showToast('请选择图片文件（JPG、PNG、WebP 等）', { tone: 'error' });
      return;
    }
    if (file.size === 0) {
      showToast('这张图片是空文件，请换一张', { tone: 'error' });
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    await loadSource(objectUrl, {
      name: file.name || '未命名图片',
      objectUrl,
    });
  }

  async function loadSource(src, meta) {
    const token = ++state.loadToken;
    cancelScheduledExtraction();
    resetDragState();
    setLoading(true, '正在读取图片');

    const k = estimatePaletteCount();
    if (!state.palette.length) {
      renderSkeletons(k);
      refs.paletteMeta.textContent = '正在准备色板…';
    }

    try {
      const image = await decodeImage(src);
      if (token !== state.loadToken) {
        revokeObjectUrl(meta.objectUrl);
        return;
      }

      refs.loadingLabel.textContent = '正在提取颜色';
      await nextPaint();

      const analysis = buildColorPoints(image);
      if (token !== state.loadToken) {
        revokeObjectUrl(meta.objectUrl);
        return;
      }

      refs.loadingLabel.textContent = '正在整理色板';
      const palette = extractPalette(analysis.points, k);
      if (token !== state.loadToken) {
        revokeObjectUrl(meta.objectUrl);
        return;
      }

      if (state.objectUrl) revokeObjectUrl(state.objectUrl);
      state.objectUrl = meta.objectUrl || null;
      state.image = image;
      state.imageSrc = src;
      state.imageName = meta.name;
      state.points = analysis.points;
      state.paletteRequestedK = k;

      commitImageUi();
      applyPalette(palette, { animate: true });
    } catch (error) {
      if (meta.objectUrl) revokeObjectUrl(meta.objectUrl);
      if (token !== state.loadToken) return;
      console.error(error);
      showToast(describeImageError(error), { tone: 'error' });
      if (!state.image) {
        resetToEmptyState();
      }
    } finally {
      if (token === state.loadToken) {
        setLoading(false);
      }
    }
  }

  function decodeImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => {
        if (!image.naturalWidth || !image.naturalHeight) {
          const error = new Error('Image has no dimensions');
          error.code = 'decode';
          reject(error);
          return;
        }
        resolve(image);
      };
      image.onerror = () => {
        const error = new Error('Image could not be decoded');
        error.code = 'decode';
        reject(error);
      };
      image.src = src;
    });
  }

  function commitImageUi() {
    state.loading = false;
    refs.previewLoading.hidden = true;
    refs.preview.classList.remove('is-loading');
    refs.preview.classList.add('has-image');
    refs.emptyState.hidden = true;
    refs.previewActions.hidden = false;
    refs.lightboxImage.src = state.imageSrc;
    refs.lightboxImage.alt = state.imageName;
    refs.lightboxTitle.textContent = state.imageName;
  }

  function setLoading(isLoading, label) {
    state.loading = isLoading;
    refs.previewLoading.hidden = !isLoading;
    refs.preview.classList.toggle('is-loading', isLoading);
    if (isLoading && label) {
      refs.loadingLabel.textContent = label;
    }
    syncActionAvailability();
  }

  function resetToEmptyState() {
    state.image = null;
    state.imageSrc = '';
    state.imageName = '';
    state.points = null;
    state.palette = [];
    state.paletteRequestedK = 0;
    if (state.objectUrl) {
      revokeObjectUrl(state.objectUrl);
      state.objectUrl = null;
    }
    refs.preview.classList.remove('has-image', 'is-loading');
    refs.previewCanvas.width = 1;
    refs.previewCanvas.height = 1;
    refs.emptyState.hidden = false;
    refs.previewActions.hidden = true;
    refs.paletteGrid.replaceChildren();
    refs.paletteGrid.setAttribute('aria-busy', 'false');
    setEmptyPaletteMessage('选择图片后自动提取');
    refs.exportButton.disabled = true;
    refs.saveButton.disabled = true;
    refs.lightboxImage.removeAttribute('src');
    refs.lightboxImage.alt = '当前图片原图';
    refs.lightboxTitle.textContent = '原图预览';
  }

  function setEmptyPaletteMessage(message) {
    refs.paletteMeta.textContent = message;
  }

  function describeImageError(error) {
    if (error && error.code === 'empty') {
      return '这张图片没有可提取的可见颜色';
    }
    if (error && (error.name === 'SecurityError' || error.name === 'InvalidStateError')) {
      return '浏览器无法读取这张图片，请换一张试试';
    }
    return '无法读取这张图片，请换一张 JPG 或 PNG';
  }

  function isImageFile(file) {
    return Boolean(
      file &&
        (file.type.startsWith('image/') ||
          /\.(jpe?g|png|webp|gif|bmp|avif|svg|heic|heif)$/i.test(file.name || ''))
    );
  }

  /* Preview interactions */

  function handlePreviewClick(event) {
    if (event.target.closest('button, input, label') || state.loading) return;
    if (!state.image) {
      openFilePicker();
      return;
    }
    openLightbox();
  }

  function openLightbox() {
    if (!state.image || refs.imageDialog.open) return;
    refs.lightboxImage.src = state.imageSrc;
    refs.lightboxTitle.textContent = state.imageName;
    refs.imageDialog.showModal();
  }

  function handlePaste(event) {
    const items = event.clipboardData && event.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          openImageFile(file);
          return;
        }
      }
    }
  }

  function handleDragEnter(event) {
    if (!dragContainsFiles(event)) return;
    event.preventDefault();
    state.dragDepth += 1;
    refs.preview.classList.add('is-dragging');
  }

  function handleDragOver(event) {
    if (!dragContainsFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    refs.preview.classList.add('is-dragging');
  }

  function handleDragLeave(event) {
    if (!dragContainsFiles(event)) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) {
      refs.preview.classList.remove('is-dragging');
    }
  }

  function handleDrop(event) {
    event.preventDefault();
    resetDragState();
    const files = event.dataTransfer && event.dataTransfer.files;
    if (!files || !files.length) return;
    const file = Array.from(files).find(isImageFile);
    if (!file) {
      showToast('拖入的不是图片文件', { tone: 'error' });
      return;
    }
    openImageFile(file);
  }

  function dragContainsFiles(event) {
    const types = event.dataTransfer && event.dataTransfer.types;
    return Boolean(types && Array.from(types).includes('Files'));
  }

  function resetDragState() {
    state.dragDepth = 0;
    refs.preview.classList.remove('is-dragging');
  }

  /* Color analysis */

  function buildColorPoints(image) {
    const maxSide = 224;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas is unavailable');

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);

    let pixels;
    try {
      pixels = context.getImageData(0, 0, width, height).data;
    } catch (error) {
      const wrapped = new Error('Canvas reading was blocked');
      wrapped.name = 'SecurityError';
      throw wrapped;
    }

    const histogram = new Map();
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] < 180) continue;
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const key = ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3);
      let bin = histogram.get(key);
      if (!bin) {
        bin = { r: 0, g: 0, b: 0, count: 0 };
        histogram.set(key, bin);
      }
      bin.r += red;
      bin.g += green;
      bin.b += blue;
      bin.count += 1;
    }

    if (histogram.size === 0) {
      const error = new Error('No opaque pixels');
      error.code = 'empty';
      throw error;
    }

    const points = [];
    let totalWeight = 0;
    for (const bin of histogram.values()) {
      const rgb = [
        Math.round(bin.r / bin.count),
        Math.round(bin.g / bin.count),
        Math.round(bin.b / bin.count),
      ];
      points.push({
        rgb,
        lab: rgbToLab(rgb),
        weight: bin.count,
      });
      totalWeight += bin.count;
    }

    return { points, totalWeight };
  }

  function extractPalette(points, requestedK) {
    const k = clamp(Math.round(requestedK), 1, Math.min(48, points.length));
    if (points.length <= k) {
      return sortPalette(
        points.map((point) => ({
          rgb: point.rgb.slice(),
          hex: rgbToHex(point.rgb),
          weight: point.weight,
        }))
      );
    }

    const centers = seedCenters(points, k);
    const count = centers.length;
    const assignments = new Int32Array(points.length);
    assignments.fill(-1);

    for (let iteration = 0; iteration < 12; iteration += 1) {
      const labSums = new Float64Array(count * 3);
      const weights = new Float64Array(count);
      let changed = false;

      for (let i = 0; i < points.length; i += 1) {
        const point = points[i];
        let bestIndex = 0;
        let bestDistance = Infinity;
        for (let c = 0; c < count; c += 1) {
          const center = centers[c];
          const dL = point.lab[0] - center[0];
          const dA = point.lab[1] - center[1];
          const dB = point.lab[2] - center[2];
          const distance = dL * dL + dA * dA + dB * dB;
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = c;
          }
        }

        if (assignments[i] !== bestIndex) {
          assignments[i] = bestIndex;
          changed = true;
        }

        const offset = bestIndex * 3;
        labSums[offset] += point.lab[0] * point.weight;
        labSums[offset + 1] += point.lab[1] * point.weight;
        labSums[offset + 2] += point.lab[2] * point.weight;
        weights[bestIndex] += point.weight;
      }

      let maxShift = 0;
      for (let c = 0; c < count; c += 1) {
        if (weights[c] === 0) continue;
        const offset = c * 3;
        const nextL = labSums[offset] / weights[c];
        const nextA = labSums[offset + 1] / weights[c];
        const nextB = labSums[offset + 2] / weights[c];
        const shiftL = nextL - centers[c][0];
        const shiftA = nextA - centers[c][1];
        const shiftB = nextB - centers[c][2];
        maxShift = Math.max(
          maxShift,
          Math.sqrt(shiftL * shiftL + shiftA * shiftA + shiftB * shiftB)
        );
        centers[c][0] = nextL;
        centers[c][1] = nextA;
        centers[c][2] = nextB;
      }

      if (!changed || maxShift < 0.025) break;
    }

    const clusters = Array.from({ length: count }, () => ({
      r: 0,
      g: 0,
      b: 0,
      weight: 0,
    }));

    for (let i = 0; i < points.length; i += 1) {
      const point = points[i];
      let bestIndex = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < count; c += 1) {
        const center = centers[c];
        const dL = point.lab[0] - center[0];
        const dA = point.lab[1] - center[1];
        const dB = point.lab[2] - center[2];
        const distance = dL * dL + dA * dA + dB * dB;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = c;
        }
      }
      const cluster = clusters[bestIndex];
      cluster.r += point.rgb[0] * point.weight;
      cluster.g += point.rgb[1] * point.weight;
      cluster.b += point.rgb[2] * point.weight;
      cluster.weight += point.weight;
    }

    const byHex = new Map();
    for (const cluster of clusters) {
      if (cluster.weight <= 0) continue;
      const rgb = [
        Math.round(cluster.r / cluster.weight),
        Math.round(cluster.g / cluster.weight),
        Math.round(cluster.b / cluster.weight),
      ];
      const hex = rgbToHex(rgb);
      const existing = byHex.get(hex);
      if (existing) {
        existing.weight += cluster.weight;
      } else {
        byHex.set(hex, { rgb, hex, weight: cluster.weight });
      }
    }

    return sortPalette(Array.from(byHex.values()));
  }

  function seedCenters(points, k) {
    let firstIndex = 0;
    for (let i = 1; i < points.length; i += 1) {
      if (points[i].weight > points[firstIndex].weight) firstIndex = i;
    }

    const centers = [points[firstIndex].lab.slice()];
    const nearest = new Float64Array(points.length);
    nearest.fill(Infinity);

    for (let i = 0; i < points.length; i += 1) {
      const dL = points[i].lab[0] - centers[0][0];
      const dA = points[i].lab[1] - centers[0][1];
      const dB = points[i].lab[2] - centers[0][2];
      nearest[i] = dL * dL + dA * dA + dB * dB;
    }

    while (centers.length < k) {
      let bestIndex = -1;
      let bestScore = 0;
      for (let i = 0; i < points.length; i += 1) {
        if (nearest[i] < 0.0001) continue;
        const score = nearest[i] * (0.5 + Math.sqrt(points[i].weight));
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }
      if (bestIndex < 0) break;

      const center = points[bestIndex].lab.slice();
      centers.push(center);
      for (let i = 0; i < points.length; i += 1) {
        const dL = points[i].lab[0] - center[0];
        const dA = points[i].lab[1] - center[1];
        const dB = points[i].lab[2] - center[2];
        const distance = dL * dL + dA * dA + dB * dB;
        if (distance < nearest[i]) nearest[i] = distance;
      }
    }

    return centers;
  }

  function sortPalette(colors) {
    const enriched = colors.map((color) => {
      const [hue, , lightness] = rgbToHsl(color.rgb);
      return { ...color, hue, lightness };
    });

    enriched.sort((a, b) => {
      const weightDelta = b.weight - a.weight;
      if (weightDelta !== 0) return weightDelta;
      if (a.hue !== b.hue) return a.hue - b.hue;
      return b.lightness - a.lightness;
    });

    return enriched;
  }

  function estimatePaletteCount() {
    return clamp(Math.round(state.precision * 0.48), 1, 48);
  }

  /* Palette rendering */

  function applyPalette(palette, options = {}) {
    state.palette = palette;
    state.paletteBusy = false;
    state.paletteRequestedK = estimatePaletteCount();
    renderPalette(palette);
    drawMosaic();
    refs.paletteMeta.textContent = `${palette.length} 种颜色 · 按占比排序`;
    refs.paletteGrid.setAttribute('aria-busy', 'false');
    syncActionAvailability();
    if (options.animate) {
      refs.previewCanvas.animate(
        [
          { opacity: 0.2, filter: 'saturate(.7)' },
          { opacity: 1, filter: 'saturate(1)' },
        ],
        { duration: 420, easing: 'ease-out' }
      );
    }
  }

  function renderPalette(colors) {
    const total = paletteTotal(colors);
    const fragment = document.createDocumentFragment();
    colors.forEach((color, index) => {
      const percentage = total > 0 ? (color.weight / total) * 100 : 100 / colors.length;
      const percentText = formatPercent(percentage);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.dataset.hex = color.hex;
      button.dataset.percent = percentText;
      button.style.setProperty('--swatch-color', color.hex);
      button.style.setProperty('--delay', `${Math.min(index, 28) * 9}ms`);
      button.title = `${color.hex} · 占比 ${percentText} · 点击复制`;
      button.setAttribute(
        'aria-label',
        `颜色 ${color.hex}，占比 ${percentText}，点击复制 HEX 色值`
      );

      const check = document.createElement('span');
      check.className = 'swatch-check';
      check.setAttribute('aria-hidden', 'true');
      check.append(createIcon('check'));
      button.append(check);
      fragment.append(button);
    });

    refs.paletteGrid.replaceChildren(fragment);
    refs.paletteGrid.setAttribute('aria-busy', 'false');
  }

  function renderSkeletons(count) {
    const skeletonCount = clamp(count, 1, 48);
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < skeletonCount; index += 1) {
      const tile = document.createElement('span');
      tile.className = 'swatch-skeleton';
      tile.style.setProperty('--delay', `${(index % 8) * 70}ms`);
      tile.setAttribute('aria-hidden', 'true');
      fragment.append(tile);
    }
    refs.paletteGrid.replaceChildren(fragment);
    refs.paletteGrid.setAttribute('aria-busy', 'true');
    refs.saveButton.disabled = true;
    refs.exportButton.disabled = true;
  }

  async function handlePaletteClick(event) {
    const swatch = event.target.closest('.swatch');
    if (!swatch) return;
    const hex = swatch.dataset.hex;
    if (!hex) return;

    const copied = await copyText(hex);
    if (!copied) {
      showToast(`无法自动复制，色值为 ${hex}`, { tone: 'error', duration: 4000 });
      return;
    }

    swatch.classList.add('is-copied');
    const previousTimer = state.copiedTimers.get(swatch);
    if (previousTimer) window.clearTimeout(previousTimer);
    const timer = window.setTimeout(() => {
      swatch.classList.remove('is-copied');
      state.copiedTimers.delete(swatch);
    }, 900);
    state.copiedTimers.set(swatch, timer);
    const percent = swatch.dataset.percent;
    showToast(percent ? `已复制 ${hex} · 占比 ${percent}` : `已复制 ${hex}`);
  }

  function handlePrecisionInput() {
    state.precision = clamp(Number(refs.precision.value), 10, 100);
    updatePrecisionUI();

    if (!state.points || state.loading) return;
    scheduleExtraction();
  }

  function scheduleExtraction() {
    window.clearTimeout(state.extractionTimer);
    state.extractionSeq += 1;
    const sequence = state.extractionSeq;
    const targetK = estimatePaletteCount();
    state.paletteBusy = true;
    syncActionAvailability();
    refs.paletteGrid.setAttribute('aria-busy', 'true');

    state.extractionTimer = window.setTimeout(() => {
      if (sequence !== state.extractionSeq || state.loading || !state.points) return;

      if (targetK === state.paletteRequestedK && state.palette.length) {
        state.paletteBusy = false;
        drawMosaic();
        refs.paletteGrid.setAttribute('aria-busy', 'false');
        syncActionAvailability();
        return;
      }

      const palette = extractPalette(state.points, targetK);
      if (sequence !== state.extractionSeq) return;
      state.paletteRequestedK = targetK;
      applyPalette(palette);
    }, 85);
  }

  function cancelScheduledExtraction() {
    window.clearTimeout(state.extractionTimer);
    state.extractionSeq += 1;
    state.paletteBusy = false;
  }

  function watchPreviewResize() {
    if (typeof ResizeObserver !== 'function') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!state.image || !state.palette.length) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => drawMosaic());
    });
    observer.observe(refs.preview);
  }

  function updatePrecisionUI() {
    const value = state.precision;
    const min = Number(refs.precision.min) || 10;
    const max = Number(refs.precision.max) || 100;
    const progress = ((value - min) / (max - min)) * 100;
    refs.precision.style.setProperty('--progress', `${progress}%`);
    refs.precisionValue.textContent = String(value);
    refs.precision.setAttribute(
      'aria-valuetext',
      `${value}，约 ${estimatePaletteCount()} 种颜色`
    );
  }

  function syncActionAvailability() {
    const ready =
      !state.loading && !state.paletteBusy && state.palette.length > 0;
    refs.saveButton.disabled = !ready;
    refs.exportButton.disabled = !ready;
    refs.paletteGrid.setAttribute(
      'aria-busy',
      String(state.loading || state.paletteBusy)
    );
  }

  function drawMosaic() {
    if (!state.image || !state.palette.length) return;
    const image = state.image;
    const canvas = refs.previewCanvas;
    const rect = refs.preview.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const aspect = rect.width / rect.height;
    const widePreview = rect.width >= 560;
    const columns = Math.round(
      (widePreview ? 23 : PREVIEW_COLUMNS_BASE) +
        (state.precision / 100) * (widePreview ? 9 : PREVIEW_COLUMNS_RANGE)
    );
    const rows = Math.max(5, Math.round(columns / aspect));

    const crop = coverCrop(
      image.naturalWidth,
      image.naturalHeight,
      aspect
    );

    canvas.width = columns;
    canvas.height = rows;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;

    context.clearRect(0, 0, columns, rows);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      image,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      columns,
      rows
    );

    let imageData;
    try {
      imageData = context.getImageData(0, 0, columns, rows);
    } catch (error) {
      console.error(error);
      return;
    }

    const paletteLabs = state.palette.map((color) => rgbToLab(color.rgb));
    const pixels = imageData.data;
    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3];
      if (alpha < 40) {
        pixels[index + 3] = 0;
        continue;
      }

      const lab = rgbToLab([pixels[index], pixels[index + 1], pixels[index + 2]]);
      let bestIndex = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < paletteLabs.length; c += 1) {
        const center = paletteLabs[c];
        const dL = lab[0] - center[0];
        const dA = lab[1] - center[1];
        const dB = lab[2] - center[2];
        const distance = dL * dL + dA * dA + dB * dB;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = c;
        }
      }

      const color = state.palette[bestIndex].rgb;
      pixels[index] = color[0];
      pixels[index + 1] = color[1];
      pixels[index + 2] = color[2];
    }

    context.putImageData(imageData, 0, 0);
  }

  /* Saving and library */

  function savePalette() {
    if (!state.palette.length || state.paletteBusy || state.loading) return;
    const name = generatePaletteName(state.palette);
    const signature = paletteSignature(state.palette);
    const duplicate = state.saved.find(
      (item) => paletteSignature(item.colors) === signature
    );

    if (duplicate) {
      showToast('这个色板已经保存过了', {
        actionLabel: '查看',
        onAction: openLibrary,
      });
      return;
    }

    const palette = {
      id: createId(),
      name,
      colors: state.palette.map((color) => ({
        hex: color.hex,
        rgb: color.rgb.slice(),
        weight: color.weight,
      })),
      createdAt: new Date().toISOString(),
    };

    state.saved.unshift(palette);
    if (state.saved.length > MAX_STORED_PALETTES) {
      state.saved.length = MAX_STORED_PALETTES;
    }
    const persisted = persistSavedPalettes();
    updateLibraryBadge();

    refs.saveButton.classList.remove('is-saved');
    void refs.saveButton.offsetWidth;
    refs.saveButton.classList.add('is-saved');
    window.setTimeout(() => refs.saveButton.classList.remove('is-saved'), 500);

    showToast(
      persisted ? `已保存「${name}」` : '已保存到当前会话，本地存储不可用',
      {
        actionLabel: '查看',
        onAction: openLibrary,
        duration: 3800,
      }
    );
  }

  function openLibrary() {
    renderLibrary();
    if (!refs.libraryDialog.open) {
      refs.libraryDialog.showModal();
    }
  }

  function renderLibrary() {
    hideToast();
    resetDeleteConfirmation();
    const fragment = document.createDocumentFragment();

    if (!state.saved.length) {
      const empty = document.createElement('div');
      empty.className = 'library-empty';

      const iconWrap = document.createElement('span');
      iconWrap.className = 'library-empty-icon';
      iconWrap.append(createIcon('swatchbook'));
      const title = document.createElement('h3');
      title.textContent = '还没有保存的色板';
      const note = document.createElement('p');
      note.textContent = '提取喜欢的颜色后，点一下「保存到色板」，以后就能在这里随时导出。';
      empty.append(iconWrap, title, note);
      fragment.append(empty);
      refs.libraryFoot.hidden = true;
    } else {
      for (const palette of state.saved) {
        fragment.append(createSavedCard(palette));
      }
      refs.libraryFoot.hidden = false;
      refs.libraryFoot.textContent = `${state.saved.length} 个色板 · 仅保存在此浏览器`;
    }

    refs.libraryList.replaceChildren(fragment);
  }

  function createSavedCard(palette) {
    const card = document.createElement('article');
    card.className = 'saved-card';

    const top = document.createElement('div');
    top.className = 'saved-top';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'saved-title';
    const title = document.createElement('h3');
    title.textContent = palette.name;
    const meta = document.createElement('p');
    meta.textContent = `${formatSavedDate(palette.createdAt)} · ${palette.colors.length} 种颜色`;
    titleWrap.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'saved-actions';
    actions.append(
      createMiniAction('export', 'download', '导出', palette.id),
      createMiniAction('delete', 'trash', '删除', palette.id)
    );
    top.append(titleWrap, actions);

    const strip = document.createElement('div');
    strip.className = 'saved-swatches';
    strip.setAttribute('aria-hidden', 'true');
    for (const color of palette.colors) {
      const swatch = document.createElement('span');
      swatch.className = 'saved-swatch';
      swatch.style.setProperty('--swatch-color', color.hex);
      strip.append(swatch);
    }

    card.append(top, strip);
    return card;
  }

  function createMiniAction(action, iconName, label, paletteId) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `mini-action${action === 'delete' ? ' delete-action' : ''}`;
    button.dataset.action = action;
    button.dataset.id = paletteId;
    button.setAttribute('aria-label', `${label}色板`);
    button.append(createIcon(iconName));
    const span = document.createElement('span');
    span.textContent = label;
    button.append(span);
    return button;
  }

  function handleLibraryAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const id = button.dataset.id;
    const palette = state.saved.find((item) => item.id === id);
    if (!palette) return;

    if (button.dataset.action === 'export') {
      resetDeleteConfirmation();
      openExportDialog(palette.name, palette.colors);
      return;
    }

    if (button.dataset.action === 'delete') {
      if (!button.classList.contains('is-confirming')) {
        resetDeleteConfirmation();
        button.classList.add('is-confirming');
        button.setAttribute('aria-label', `再次点击确认删除${palette.name}`);
        const label = button.querySelector('span');
        if (label) label.textContent = '确认';
        state.deleteTimer = window.setTimeout(resetDeleteConfirmation, 3000);
        return;
      }

      state.saved = state.saved.filter((item) => item.id !== id);
      persistSavedPalettes();
      updateLibraryBadge();
      resetDeleteConfirmation();
      renderLibrary();
    }
  }

  function resetDeleteConfirmation() {
    window.clearTimeout(state.deleteTimer);
    state.deleteTimer = 0;
    refs.libraryList.querySelectorAll('.mini-action.is-confirming').forEach((button) => {
      button.classList.remove('is-confirming');
      const label = button.querySelector('span');
      if (label) label.textContent = '删除';
      button.setAttribute('aria-label', '删除色板');
      button.title = '删除色板';
    });
  }

  function updateLibraryBadge() {
    const count = state.saved.length;
    refs.libraryBadge.hidden = count === 0;
    refs.libraryBadge.textContent = count > 99 ? '99+' : String(count);
    refs.libraryButton.setAttribute(
      'aria-label',
      count ? `打开我的色板，已保存 ${count} 个` : '打开我的色板'
    );
  }

  function loadSavedPalettes() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .slice(0, MAX_STORED_PALETTES)
        .map(normalizeSavedPalette)
        .filter(Boolean);
    } catch (error) {
      console.warn('Unable to read saved palettes', error);
      return [];
    }
  }

  function normalizeSavedPalette(item) {
    if (!item || !Array.isArray(item.colors)) return null;
    const colors = item.colors
      .slice(0, 48)
      .map(normalizeColor)
      .filter(Boolean)
      .sort((a, b) => b.weight - a.weight || a.hex.localeCompare(b.hex));
    if (!colors.length) return null;
    const name =
      typeof item.name === 'string' && item.name.trim()
        ? item.name.trim().slice(0, 60)
        : generatePaletteName(colors);
    const createdAt =
      typeof item.createdAt === 'string' && !Number.isNaN(Date.parse(item.createdAt))
        ? item.createdAt
        : new Date().toISOString();

    return {
      id: typeof item.id === 'string' && item.id ? item.id : createId(),
      name,
      colors,
      createdAt,
    };
  }

  function normalizeColor(color) {
    if (!color || !Array.isArray(color.rgb) || color.rgb.length < 3) return null;
    const rgb = color.rgb.slice(0, 3).map((value) => Number(value));
    if (rgb.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) {
      return null;
    }
    const rounded = rgb.map((value) => Math.round(value));
    let weight = Number(color.weight);
    if (!Number.isFinite(weight) || weight <= 0) weight = 1;
    return {
      rgb: rounded,
      hex: rgbToHex(rounded),
      weight,
    };
  }

  function persistSavedPalettes() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.saved));
      return true;
    } catch (error) {
      console.warn('Unable to save palettes', error);
      return false;
    }
  }

  /* Export */

  function openExportDialog(name, colors) {
    if (!colors || !colors.length) return;
    state.exportPayload = {
      name: name || '色板',
      colors: colors.map((color) => ({
        hex: color.hex,
        rgb: color.rgb.slice(),
        weight: color.weight,
      })),
    };
    refs.exportSubtitle.textContent = `“${state.exportPayload.name}” · ${colors.length} 种颜色`;
    renderColorStrip(refs.exportStrip, colors);
    if (!refs.exportDialog.open) {
      refs.exportDialog.showModal();
    }
  }

  function renderColorStrip(container, colors) {
    const fragment = document.createDocumentFragment();
    for (const color of colors) {
      const swatch = document.createElement('span');
      swatch.className = 'export-swatch';
      swatch.style.setProperty('--swatch-color', color.hex);
      fragment.append(swatch);
    }
    container.replaceChildren(fragment);
  }

  function handleFormatSelection(event) {
    const button = event.target.closest('[data-format]');
    if (!button || !state.exportPayload) return;
    const formatKey = button.dataset.format;
    const format = FORMAT_META[formatKey];
    if (!format) return;

    const payload = state.exportPayload;
    try {
      const result = buildFormat(formatKey, payload.name, payload.colors);
      const blob =
        result instanceof Uint8Array
          ? new Blob([result], { type: format.mime })
          : new Blob([result], { type: format.mime });
      const filename = `${safeFileBase(payload.name)}-${payload.colors.length}色.${format.ext}`;
      triggerDownload(blob, filename);
      closeSheets();
      window.setTimeout(() => {
        showToast(`已导出 ${format.toastLabel} 色板`);
      }, 40);
    } catch (error) {
      console.error(error);
      closeSheets();
      window.setTimeout(() => {
        showToast('导出失败，请稍后重试', { tone: 'error' });
      }, 40);
    }
  }

  function closeSheets() {
    if (refs.exportDialog.open) refs.exportDialog.close();
    if (refs.libraryDialog.open) refs.libraryDialog.close();
  }

  function buildFormat(format, name, colors) {
    switch (format) {
      case 'css':
        return buildCssPalette(name, colors);
      case 'json':
        return buildJsonPalette(name, colors);
      case 'gpl':
        return buildGplPalette(name, colors);
      case 'ase':
        return buildAsePalette(name, colors);
      default:
        throw new Error(`Unknown palette format: ${format}`);
    }
  }

  function buildCssPalette(name, colors) {
    const total = paletteTotal(colors);
    const commentName = sanitizeComment(name || '色板');
    const lines = colors.map((color, index) => {
      const percentage = total > 0 ? (color.weight / total) * 100 : 0;
      return `  --color-${String(index + 1).padStart(2, '0')}: ${color.hex}; /* ${formatPercent(percentage)} */`;
    });
    return `/* ${commentName} · ${colors.length} colors · generated locally */\n\n:root {\n${lines.join('\n')}\n}\n`;
  }

  function buildJsonPalette(name, colors) {
    const total = paletteTotal(colors);
    const payload = {
      name,
      colorCount: colors.length,
      generatedAt: new Date().toISOString(),
      colors: colors.map((color) => {
        const [hue, saturation, lightness] = rgbToHsl(color.rgb);
        return {
          hex: color.hex,
          rgb: color.rgb.slice(),
          hsl: {
            h: round(hue, 1),
            s: round(saturation * 100, 1),
            l: round(lightness * 100, 1),
          },
          percentage: round(total > 0 ? (color.weight / total) * 100 : 0, 2),
        };
      }),
    };
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  function buildGplPalette(name, colors) {
    const total = paletteTotal(colors);
    const displayName = sanitizeSingleLine(name || '色板').slice(0, 80);
    const lines = ['GIMP Palette', `Name: ${displayName}`, 'Columns: 12', '#'];
    colors.forEach((color, index) => {
      const percentage = total > 0 ? (color.weight / total) * 100 : 0;
      const rgba = color.rgb;
      lines.push(
        `${String(rgba[0]).padStart(3, ' ')} ${String(rgba[1]).padStart(3, ' ')} ` +
          `${String(rgba[2]).padStart(3, ' ')}\tcolor-${String(index + 1).padStart(2, '0')} ` +
          `${color.hex} ${formatPercent(percentage)}`
      );
    });
    return `${lines.join('\n')}\n`;
  }

  function buildAsePalette(name, colors) {
    const groupName = sanitizeSingleLine(name || 'Color Palette').slice(0, 40);
    const groupNameBytes = utf16Bytes(groupName);
    const groupContent = new Uint8Array(2 + groupNameBytes.length);
    const groupView = new DataView(groupContent.buffer);
    groupView.setUint16(0, groupName.length + 1, false);
    groupContent.set(groupNameBytes, 2);

    const blocks = [{ type: 0xc001, content: groupContent }];

    colors.forEach((color, index) => {
      const colorName = `${String(index + 1).padStart(2, '0')} ${color.hex}`;
      const colorNameBytes = utf16Bytes(colorName);
      const content = new Uint8Array(2 + colorNameBytes.length + 4 + 12 + 2);
      const view = new DataView(content.buffer);
      let offset = 0;

      view.setUint16(offset, colorName.length + 1, false);
      offset += 2;
      content.set(colorNameBytes, offset);
      offset += colorNameBytes.length;
      content.set([0x52, 0x47, 0x42, 0x20], offset);
      offset += 4;
      view.setFloat32(offset, color.rgb[0] / 255, false);
      offset += 4;
      view.setFloat32(offset, color.rgb[1] / 255, false);
      offset += 4;
      view.setFloat32(offset, color.rgb[2] / 255, false);
      offset += 4;
      view.setUint16(offset, 2, false);

      blocks.push({ type: 0x0001, content });
    });

    blocks.push({ type: 0xc002, content: new Uint8Array(0) });

    const totalLength = blocks.reduce(
      (length, block) => length + 6 + block.content.length,
      12
    );
    const buffer = new ArrayBuffer(totalLength);
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    bytes.set([0x41, 0x53, 0x45, 0x46], 0);
    view.setUint16(4, 1, false);
    view.setUint16(6, 0, false);
    view.setUint32(8, blocks.length, false);

    let offset = 12;
    for (const block of blocks) {
      view.setUint16(offset, block.type, false);
      view.setUint32(offset + 2, block.content.length, false);
      offset += 6;
      bytes.set(block.content, offset);
      offset += block.content.length;
    }

    return bytes;
  }

  function utf16Bytes(value) {
    const bytes = new Uint8Array((value.length + 1) * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < value.length; index += 1) {
      view.setUint16(index * 2, value.charCodeAt(index), false);
    }
    view.setUint16(value.length * 2, 0, false);
    return bytes;
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function safeFileBase(name) {
    const cleaned = sanitizeSingleLine(name || 'color-palette')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
      .replace(/\s*[·•]+\s*/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/[.。]+$/g, '')
      .slice(0, 48)
      .replace(/^-+|-+$/g, '');
    return cleaned || 'color-palette';
  }

  function generatePaletteName(colors) {
    if (!colors || !colors.length) return '未命名色板';
    const total = paletteTotal(colors);
    let chromaticWeight = 0;
    let neutralLightness = 0;
    let neutralWeight = 0;
    const hueWeights = new Map();

    for (const color of colors) {
      const [hue, saturation, lightness] = rgbToHsl(color.rgb);
      const weight = color.weight || 1;
      if (saturation < 0.1) {
        neutralWeight += weight;
        neutralLightness += lightness * weight;
      } else {
        chromaticWeight += weight;
        const bucket = hueName(hue);
        hueWeights.set(bucket, (hueWeights.get(bucket) || 0) + weight);
      }
    }

    if (chromaticWeight / total < 0.38) {
      const lightness = neutralWeight ? neutralLightness / neutralWeight : 0.45;
      let base = '石墨';
      if (lightness > 0.82) base = '月白';
      else if (lightness > 0.66) base = '浅岩';
      else if (lightness > 0.48) base = '岩灰';
      else if (lightness > 0.3) base = '石墨';
      else base = '墨夜';
      return `${base}灰调`;
    }

    const ranked = Array.from(hueWeights.entries()).sort((a, b) => b[1] - a[1]);
    const primary = ranked[0] ? ranked[0][0] : '混色';
    const secondaryEntry = ranked[1];
    if (secondaryEntry && secondaryEntry[1] / total >= 0.12) {
      return `${primary} · ${secondaryEntry[0]}`;
    }
    return `${primary}色板`;
  }

  function hueName(hue) {
    if (hue < 18 || hue >= 346) return '赤霞';
    if (hue < 40) return '余烬';
    if (hue < 62) return '琥珀';
    if (hue < 92) return '苔原';
    if (hue < 140) return '森野';
    if (hue < 168) return '薄荷';
    if (hue < 195) return '青川';
    if (hue < 225) return '海盐';
    if (hue < 255) return '雾蓝';
    if (hue < 290) return '暮紫';
    if (hue < 325) return '鸢尾';
    return '玫瑰';
  }

  /* Utilities */

  function coverCrop(width, height, targetRatio) {
    const imageRatio = width / height;
    if (imageRatio > targetRatio) {
      const cropWidth = height * targetRatio;
      return {
        x: (width - cropWidth) / 2,
        y: 0,
        width: cropWidth,
        height,
      };
    }
    const cropHeight = width / targetRatio;
    return {
      x: 0,
      y: (height - cropHeight) / 2,
      width,
      height: cropHeight,
    };
  }

  function rgbToLab(rgb) {
    const red = srgbToLinear(rgb[0] / 255);
    const green = srgbToLinear(rgb[1] / 255);
    const blue = srgbToLinear(rgb[2] / 255);

    const x = (red * 0.4124564 + green * 0.3575761 + blue * 0.1804375) / 0.95047;
    const y = red * 0.2126729 + green * 0.7151522 + blue * 0.072175;
    const z = (red * 0.0193339 + green * 0.119192 + blue * 0.9503041) / 1.08883;

    const fx = labPivot(x);
    const fy = labPivot(y);
    const fz = labPivot(z);

    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function srgbToLinear(value) {
    return value <= 0.04045
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  }

  function labPivot(value) {
    return value > 0.008856
      ? Math.cbrt(value)
      : 7.787 * value + 16 / 116;
  }

  function rgbToHsl(rgb) {
    const red = rgb[0] / 255;
    const green = rgb[1] / 255;
    const blue = rgb[2] / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const lightness = (max + min) / 2;
    let hue = 0;
    let saturation = 0;

    if (max !== min) {
      const delta = max - min;
      saturation =
        lightness > 0.5
          ? delta / (2 - max - min)
          : delta / (max + min);
      if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
      else if (max === green) hue = (blue - red) / delta + 2;
      else hue = (red - green) / delta + 4;
      hue *= 60;
    }

    return [hue, saturation, lightness];
  }

  function rgbToHex(rgb) {
    return `#${rgb
      .slice(0, 3)
      .map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()}`;
  }

  function paletteTotal(colors) {
    const total = colors.reduce((sum, color) => {
      const weight = Number(color.weight);
      return sum + (Number.isFinite(weight) && weight > 0 ? weight : 1);
    }, 0);
    return total || colors.length || 1;
  }

  function paletteSignature(colors) {
    return colors.map((color) => (color.hex || '').toUpperCase()).join('|');
  }

  function formatPercent(percentage) {
    if (!Number.isFinite(percentage)) return '0%';
    if (percentage >= 10) return `${percentage.toFixed(0)}%`;
    if (percentage >= 1) return `${percentage.toFixed(1)}%`;
    return `${percentage.toFixed(2)}%`;
  }

  function formatSavedDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '刚刚';
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const days = Math.round((startOfToday - startOfDate) / 86400000);
    const time = date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    if (days === 0) return `今天 ${time}`;
    if (days === 1) return `昨天 ${time}`;
    if (days > 1 && days < 7) return `${days} 天前`;
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  }

  function sanitizeSingleLine(value) {
    return String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function sanitizeComment(value) {
    return sanitizeSingleLine(value).replace(/\*\//g, '* /');
  }

  function round(value, decimals = 0) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function createId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `palette-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function createIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function revokeObjectUrl(url) {
    if (!url) return;
    try {
      URL.revokeObjectURL(url);
    } catch (error) {
      console.warn('Unable to revoke object URL', error);
    }
  }

  function nextPaint() {
    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        resolve();
      };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      window.setTimeout(finish, 80);
    });
  }

  async function copyText(value) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch (error) {
        // Fall back to the legacy path for pages opened from file://.
      }
    }

    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (error) {
      copied = false;
    }
    textarea.remove();
    return copied;
  }

  function showToast(message, options = {}) {
    const {
      tone = 'success',
      actionLabel = '',
      onAction = null,
      duration = actionLabel ? 4200 : 2300,
    } = options;

    window.clearTimeout(state.toastTimer);
    state.toastActionHandler = onAction;
    refs.toastMessage.textContent = message;
    refs.toast.classList.toggle('is-error', tone === 'error');
    refs.toastIconUse.setAttribute(
      'href',
      tone === 'error' ? '#i-alert' : '#i-check'
    );
    refs.toastAction.hidden = !actionLabel;
    refs.toastAction.textContent = actionLabel;
    refs.toast.classList.add('is-visible');
    state.toastTimer = window.setTimeout(hideToast, duration);
  }

  function hideToast() {
    window.clearTimeout(state.toastTimer);
    refs.toast.classList.remove('is-visible');
    state.toastActionHandler = null;
  }

  function handleSheetBackdropClick(event) {
    const dialog = event.currentTarget;
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const outside =
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom;
    if (outside) dialog.close();
  }

  init();
})();
