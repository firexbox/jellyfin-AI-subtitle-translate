/**
 * Dual Subtitle Renderer
 * True bilingual display: original text + translated text on separate lines
 * Uses Shadow DOM for style isolation
 */

class DualSubtitleRenderer {
  constructor() {
    this.host = null;
    this.shadow = null;
    this.container = null;
    this.video = null;
    this.settings = {};
    this.translationCache = new Map();
    this._originalSpan = null;
    this._translatedSpan = null;
    this._lastShowTime = 0;
    this._lastOriginal = '';
    this._lastTranslated = '';
  }

  init(videoElement, settings = {}) {
    this.video = videoElement;
    this.settings = {
      position: 'top',          // 'top' or 'bottom' - where to put translated line
      originalPosition: 'bottom', // opposite of position by default
      fontSize: 20,
      fontColor: '#ffffff',
      strokeColor: '#000000',
      strokeWidth: 2,
      backgroundColor: 'rgba(0,0,0,0.5)',
      translatedBackground: 'rgba(0,0,0,0.6)',
      maxWidth: '85vw',
      lineHeight: 1.4,
      debug: false,
      ...settings
    };
    this._createShadowHost();
    this._setupPositioning();
    console.log('[JDS] Renderer initialized (Bilingual v5)');
  }

  _createShadowHost() {
    this.destroy();

    const host = document.createElement('div');
    host.id = 'jds-dual-subtitle-host';
    host.style.cssText = `
      all: initial !important;
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      pointer-events: none !important;
      z-index: 2147483647 !important;
      overflow: visible !important;
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
      background: transparent !important;
      margin: 0 !important;
      padding: 0 !important;
      border: none !important;
    `;

    this.shadow = host.attachShadow({ mode: 'closed' });

    const container = document.createElement('div');
    container.id = 'jds-dual-subtitle-container';
    const borderStyle = this.settings.debug
      ? 'border: 3px dashed red !important;'
      : 'border: none !important;';

    container.style.cssText = `
      position: absolute !important;
      left: 50% !important;
      transform: translateX(-50%) !important;
      text-align: center !important;
      max-width: ${this.settings.maxWidth} !important;
      width: auto !important;
      display: flex !important;
      flex-direction: column !important;
      align-items: center !important;
      gap: 4px !important;
      visibility: visible !important;
      opacity: 0 !important;
      ${borderStyle}
      background: transparent !important;
      margin: 0 !important;
      padding: 0 !important;
      pointer-events: none !important;
      transition: opacity 0.15s ease !important;
    `;

    // Original text line
    const originalSpan = document.createElement('div');
    originalSpan.id = 'jds-original-text';
    originalSpan.style.cssText = this._getOriginalStyles();
    container.appendChild(originalSpan);

    // Translated text line
    const translatedSpan = document.createElement('div');
    translatedSpan.id = 'jds-translated-text';
    translatedSpan.style.cssText = this._getTranslatedStyles();
    container.appendChild(translatedSpan);

    this.shadow.appendChild(container);
    document.body.appendChild(host);

    this.host = host;
    this.container = container;
    this._originalSpan = originalSpan;
    this._translatedSpan = translatedSpan;
    this._positionContainer();
  }

  _getBaseStyles() {
    const s = this.settings;
    return `
      display: inline-block !important;
      font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "WenQuanYi Micro Hei", "Hiragino Sans GB", "Heiti SC", sans-serif !important;
      font-size: ${s.fontSize}px !important;
      font-weight: 600 !important;
      color: ${s.fontColor} !important;
      text-shadow:
        -${s.strokeWidth}px -${s.strokeWidth}px 0 ${s.strokeColor},
        ${s.strokeWidth}px -${s.strokeWidth}px 0 ${s.strokeColor},
        -${s.strokeWidth}px ${s.strokeWidth}px 0 ${s.strokeColor},
        ${s.strokeWidth}px ${s.strokeWidth}px 0 ${s.strokeColor},
        0 0 ${s.strokeWidth * 4}px ${s.strokeColor} !important;
      line-height: ${s.lineHeight} !important;
      padding: 6px 16px !important;
      border-radius: 6px !important;
      white-space: pre-wrap !important;
      word-wrap: break-word !important;
      max-width: 100% !important;
      min-width: 40px !important;
      text-align: center !important;
      letter-spacing: 0.5px !important;
    `;
  }

  _getOriginalStyles() {
    return this._getBaseStyles() + `
      background: ${this.settings.backgroundColor} !important;
      opacity: 0.85 !important;
    `;
  }

  _getTranslatedStyles() {
    return this._getBaseStyles() + `
      background: ${this.settings.translatedBackground} !important;
      font-size: ${this.settings.fontSize * 1.05}px !important;
      color: #ffeb3b !important;
    `;
  }

  _positionContainer() {
    if (!this.container || !this.video || !this.host) return;

    const videoRect = this.video.getBoundingClientRect();
    const vh = window.innerHeight;

    const baseWidth = 1280;
    const scale = Math.max(0.6, Math.min(videoRect.width / baseWidth, 1.6));
    const fontSize = Math.round(this.settings.fontSize * scale);

    if (this._originalSpan) this._originalSpan.style.fontSize = `${fontSize}px`;
    if (this._translatedSpan) this._translatedSpan.style.fontSize = `${Math.round(fontSize * 1.05)}px`;

    const videoCenterX = videoRect.left + videoRect.width / 2;
    this.container.style.left = `${videoCenterX}px`;

    // Position the container based on where translated line should go
    if (this.settings.position === 'top') {
      // Translated on top, original below it
      const top = Math.max(10, videoRect.top + videoRect.height * 0.04);
      this.container.style.top = `${top}px`;
      this.container.style.bottom = 'auto';
      this.container.style.flexDirection = 'column';
    } else {
      // Translated on bottom, original above it
      const bottom = Math.max(10, vh - videoRect.bottom + videoRect.height * 0.06);
      this.container.style.bottom = `${bottom}px`;
      this.container.style.top = 'auto';
      this.container.style.flexDirection = 'column-reverse';
    }
  }

  _setupPositioning() {
    const handler = () => this._positionContainer();

    window.addEventListener('resize', handler);
    window.addEventListener('scroll', handler, true);

    const fsHandler = () => {
      [100, 500, 1000, 2000].forEach(d => setTimeout(handler, d));
    };
    document.addEventListener('fullscreenchange', fsHandler);
    document.addEventListener('webkitfullscreenchange', fsHandler);
    document.addEventListener('mozfullscreenchange', fsHandler);
    document.addEventListener('MSFullscreenChange', fsHandler);

    this._posInterval = setInterval(handler, 100);

    if (window.ResizeObserver && this.video) {
      this.resizeObserver = new ResizeObserver(handler);
      this.resizeObserver.observe(this.video);
    }

    this._checkInterval = setInterval(() => {
      if (this.host && !document.body.contains(this.host)) {
        console.warn('[JDS] Host was removed from DOM, recreating...');
        this._createShadowHost();
      }
    }, 2000);

    handler();
  }

  /**
   * Strip HTML/ASS markup tags from subtitle text
   */
  _stripTags(text) {
    if (!text) return text;
    return text
      .replace(/<\/?[^>]+>/gi, '')
      .replace(/\{[^}]*\}/g, '')
      .trim();
  }

  /**
   * Show bilingual subtitle
   * @param {string} original - original subtitle text
   * @param {string} translated - translated text (can be empty if not ready)
   */
  show(original, translated) {
    if (!this.container) {
      console.warn('[JDS] Renderer not initialized');
      return;
    }

    // Final tag filtering before display
    original = this._stripTags(original);
    translated = this._stripTags(translated);

    if (!original) {
      this.hide(100);
      return;
    }

    // Deduplicate within ~2 frames (33ms) to prevent RAF + timeupdate double-fire
    const now = performance.now();
    if (now - this._lastShowTime < 33 && this._lastOriginal === original && this._lastTranslated === translated) {
      return;
    }
    this._lastShowTime = now;
    this._lastOriginal = original;
    this._lastTranslated = translated;

    // Ensure elements exist
    if (!this._originalSpan || !this.container.contains(this._originalSpan)) {
      this._originalSpan = this.container.querySelector('#jds-original-text');
    }
    if (!this._translatedSpan || !this.container.contains(this._translatedSpan)) {
      this._translatedSpan = this.container.querySelector('#jds-translated-text');
    }

    if (this._originalSpan) {
      this._originalSpan.textContent = original;
    }
    if (this._translatedSpan) {
      // If no translation yet, show placeholder or hide
      if (translated && translated !== original) {
        this._translatedSpan.textContent = translated;
        this._translatedSpan.style.display = 'inline-block';
      } else {
        // Translation not ready - hide the translated line to avoid showing original there
        this._translatedSpan.style.display = 'none';
      }
    }

    this.container.style.opacity = '1';
    this.container.style.display = 'flex';
    this.container.style.visibility = 'visible';

    this._positionContainer();
    console.log('[JDS] Showing:', original.substring(0, 40), '|', (translated || '...').substring(0, 40));
    this._clearHideTimer();
  }

  hide(delay = 0) {
    if (!this.container) return;
    this._clearHideTimer();
    if (delay > 0) {
      this.hideTimer = setTimeout(() => {
        if (this.container) this.container.style.opacity = '0';
      }, delay);
    } else {
      this.container.style.opacity = '0';
    }
  }

  _clearHideTimer() {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    if (this.container) {
      if (this._originalSpan) this._originalSpan.style.cssText = this._getOriginalStyles();
      if (this._translatedSpan) this._translatedSpan.style.cssText = this._getTranslatedStyles();
      this._positionContainer();
    }
  }

  getCacheKey(text) {
    // v3 prefix: single-item plain-text translation (no [index] markers)
    return `v3-${this.settings.targetLang || 'zh'}-${text}`;
  }

  getCached(text) {
    return this.translationCache.get(this.getCacheKey(text));
  }

  setCache(text, translated) {
    if (!text || !translated) return;
    this.translationCache.set(this.getCacheKey(text), translated);
    if (this.translationCache.size > 5000) {
      const firstKey = this.translationCache.keys().next().value;
      this.translationCache.delete(firstKey);
    }
  }

  clearCache() {
    this.translationCache.clear();
    this.currentTranslatedText = '';
  }

  destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this._posInterval) {
      clearInterval(this._posInterval);
      this._posInterval = null;
    }
    if (this._checkInterval) {
      clearInterval(this._checkInterval);
      this._checkInterval = null;
    }
    if (this.host && this.host.parentElement) {
      this.host.parentElement.removeChild(this.host);
    }
    this.host = null;
    this.shadow = null;
    this.container = null;
    this._originalSpan = null;
    this._translatedSpan = null;
    this._clearHideTimer();
  }
}

if (typeof window !== 'undefined') {
  window.DualSubtitleRenderer = DualSubtitleRenderer;
}
