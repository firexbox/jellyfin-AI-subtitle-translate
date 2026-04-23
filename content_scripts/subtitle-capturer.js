/**
 * Subtitle Capturer for Jellyfin
 * Passes active cues as array to support multi-line overlapping subtitles
 */

class JellyfinSubtitleCapturer {
  constructor() {
    this.video = null;
    this.textTrack = null;
    this.onCueChange = null;
    this.observer = null;
    this.currentCues = [];
    this.lastCuesJson = '';
    this.lastCueId = null;
    this.subtitleContainer = null;
    this.fetchInterceptorActive = false;
    this.capturedSubtitleUrl = null;
    this.capturedSubtitleContent = null;
    this.subtitleFormat = null;
    this.domCheckInterval = null;
    this.isJellyfin = false;
    this.cueHistory = new Set();
    this.lastCheckTime = 0;
    this._videoSrcInterval = null;
    this._subtitleButtonListener = null;
    this._timeupdateListener = null;
  }

  start(videoElement) {
    this.video = videoElement;
    this.isJellyfin = window.location.href.includes('/web/') ||
                      document.querySelector('.skinHeader') !== null ||
                      document.querySelector('.videoPlayerContainer') !== null ||
                      document.querySelector('[data-role="page"]') !== null;
    console.log('[JDS] Starting capturer, isJellyfin=' + this.isJellyfin);

    this._interceptFetch();
    this._monitorTextTracks();
    this._monitorDOMSubtitles();
    this._monitorVideoSrc();
    this._monitorSubtitleButton();

    if (this.video) {
      this._timeupdateListener = () => this._checkActiveCues();
      this.video.addEventListener('timeupdate', this._timeupdateListener);
    }
  }

  stop() {
    if (this.observer) { this.observer.disconnect(); this.observer = null; }
    if (this.domCheckInterval) { clearInterval(this.domCheckInterval); this.domCheckInterval = null; }
    if (this._videoSrcInterval) { clearInterval(this._videoSrcInterval); this._videoSrcInterval = null; }
    if (this._subtitleButtonListener) {
      document.removeEventListener('click', this._subtitleButtonListener, true);
      this._subtitleButtonListener = null;
    }
    if (this.video && this._timeupdateListener) {
      this.video.removeEventListener('timeupdate', this._timeupdateListener);
      this._timeupdateListener = null;
    }
    this.video = null;
    this.textTrack = null;
  }

  _interceptFetch() {
    // Use a global flag to prevent multiple nested wrappers on window.fetch
    if (window.__jdsFetchIntercepted) return;
    window.__jdsFetchIntercepted = true;

    // Store the REAL original fetch (before any wrappers)
    if (!window.__jdsOriginalFetch) {
      window.__jdsOriginalFetch = window.fetch;
    }

    const originalFetch = window.__jdsOriginalFetch;
    const self = this;

    window.fetch = async function(...args) {
      const url = args[0];
      if (typeof url === 'string' && self._isSubtitleUrl(url)) {
        try {
          const response = await originalFetch.apply(this, args);
          const clone = response.clone();
          clone.text().then(text => {
            self.capturedSubtitleUrl = url;
            self.capturedSubtitleContent = text;
            self.subtitleFormat = self._detectFormatFromUrl(url);
            console.log('[JDS] Subtitle file captured:', url, 'size:', text.length, 'format:', self.subtitleFormat);
            self._emit('subtitleLoaded', { url, text, format: self.subtitleFormat });
          });
          return response;
        } catch (e) {
          return originalFetch.apply(this, args);
        }
      }
      return originalFetch.apply(this, args);
    };
  }

  _isSubtitleUrl(url) {
    return /\.srt(\?|$)/i.test(url) ||
           /\.ass(\?|$)/i.test(url) ||
           /\.ssa(\?|$)/i.test(url) ||
           /\.vtt(\?|$)/i.test(url) ||
           /\/Subtitles\/\d+\/\d+\/\w+/i.test(url) ||
           /Stream\.srt/i.test(url) ||
           /Stream\.vtt/i.test(url) ||
           /subtitle/i.test(url);
  }

  _detectFormatFromUrl(url) {
    if (/\.srt/i.test(url)) return 'srt';
    if (/\.ass/i.test(url) || /\.ssa/i.test(url)) return 'ass';
    if (/\.vtt/i.test(url)) return 'vtt';
    return null;
  }

  _monitorTextTracks() {
    if (!this.video) return;
    for (let i = 0; i < this.video.textTracks.length; i++) {
      this._attachTextTrack(this.video.textTracks[i]);
    }

    const observer = new MutationObserver(() => {
      this._checkTextTracks();
    });
    if (this.video.parentElement) {
      observer.observe(this.video.parentElement, { childList: true, subtree: true });
    }
    setInterval(() => this._checkTextTracks(), 2000);
  }

  _checkTextTracks() {
    if (!this.video) return;
    for (let i = 0; i < this.video.textTracks.length; i++) {
      const track = this.video.textTracks[i];
      if (track.kind === 'subtitles' || track.kind === 'captions') {
        if (!track._jdsAttached) {
          this._attachTextTrack(track);
        }
      }
    }
  }

  _attachTextTrack(track) {
    track._jdsAttached = true;
    this.textTrack = track;
    console.log('[JDS] TextTrack attached:', track.label, track.language, 'mode:', track.mode);

    track.addEventListener('cuechange', () => this._checkActiveCues());
    if (this.video) this.video.addEventListener('timeupdate', () => this._checkActiveCues());
  }

  /**
   * Extract all active cues from all text tracks and pass them as an array.
   * CHANGE: instead of joining into one string, pass cues array so
   * jellyfin-inject.js can translate each one individually.
   */
  // Strip HTML/ASS markup tags from subtitle text
  _stripTags(text) {
    if (!text) return text;
    return text
      .replace(/<\/?[^>]+>/gi, '')   // HTML tags: <font>, <i>, <b>, <br>, <./font>, </font>
      .replace(/\{[^}]*\}/g, '')      // ASS override tags: {\an5}, {\pos(100,200)}
      .trim();
  }

  _checkActiveCues() {
    if (!this.video || !this.video.textTracks) return;

    const allCues = [];
    for (let i = 0; i < this.video.textTracks.length; i++) {
      const track = this.video.textTracks[i];
      if (track.mode === 'disabled') continue;
      if (track.activeCues) {
        for (let j = 0; j < track.activeCues.length; j++) {
          const cue = track.activeCues[j];
          const cleanText = cue.text ? this._stripTags(cue.text) : '';
          if (cleanText) {
            allCues.push({
              text: cleanText,
              startTime: cue.startTime,
              endTime: cue.endTime,
              id: cue.id || `${cue.startTime}-${cue.endTime}`,
              track: i
            });
          }
        }
      }
    }

    // Deduplicate by id+text to preserve multi-line cues with same time range
    const seen = new Set();
    const uniqueCues = [];
    for (const cue of allCues) {
      const key = cue.id ? `${cue.track}-${cue.id}` : `${cue.track}-${cue.startTime}-${cue.endTime}-${cue.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueCues.push(cue);
      }
    }

    // Compare JSON to detect changes
    const cuesJson = JSON.stringify(uniqueCues.map(c => c.id));
    if (cuesJson !== this.lastCuesJson) {
      this.lastCuesJson = cuesJson;
      this.currentCues = uniqueCues;
      const combinedText = uniqueCues.map(c => c.text).join('\n');
      this.lastText = combinedText;
      if (this.onCueChange) {
        this.onCueChange({ text: combinedText, cues: uniqueCues, source: 'texttrack' });
      }
    }
  }

  _monitorDOMSubtitles() {
    const self = this;

    const isSubtitleLike = (el) => {
      if (!el || el.id === 'jds-dual-subtitle-host') return false;
      const text = (el.textContent || '').trim();
      if (!text || text.length === 0 || text.length > 250) return false;

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
      return true;
    };

    const checkSubtitles = () => {
      if (!this.video) return;
      const vRect = this.video.getBoundingClientRect();

      // 1. Known Jellyfin subtitle containers
      const selectors = [
        '.subtitleContainer',
        '.videoSubtitles',
        '.subtitle-text',
        '.videoPlayerContainer .subtitle',
        '.videoPlayerContainer [class*="subtitle"]',
        '.videoPlayerContainer [class*="caption"]',
        '.vjs-text-track-display div',
        '.shaka-text-container span',
        '.bmpui-ui-subtitle-overlay .bmpui-ui-label',
      ];

      for (const sel of selectors) {
        try {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            const text = this._stripTags(el.textContent || '');
            if (text && text !== this.lastText) {
              this.lastText = text;
              this.subtitleContainer = el;
              // Wrap single DOM text into a cue-like object
              if (this.onCueChange) {
                this.onCueChange({
                  text,
                  cues: [{ text, startTime: 0, endTime: 99999, id: 'dom-' + Date.now() }],
                  source: 'dom',
                  element: el
                });
              }
              return;
            }
          }
        } catch (e) {}
      }

      // 2. Deep scan inside video container
      const videoContainer = this.video.closest('.videoPlayerContainer, .videoPlayer, [class*="player"]') || this.video.parentElement;
      if (videoContainer) {
        const candidates = videoContainer.querySelectorAll('div, span');
        for (const el of candidates) {
          if (!isSubtitleLike(el)) continue;
          const rect = el.getBoundingClientRect();
          const isCentered = (rect.left + rect.right) / 2 > vRect.left && (rect.left + rect.right) / 2 < vRect.right;
          const isLower = rect.top > vRect.top + vRect.height * 0.55;
          const isSmall = el.children.length <= 3 && (el.textContent || '').trim().length < 200;

          if (isCentered && isLower && isSmall) {
            const text = this._stripTags(el.textContent || '');
            if (text && text !== this.lastText) {
              this.lastText = text;
              this.subtitleContainer = el;
              if (this.onCueChange) {
                this.onCueChange({
                  text,
                  cues: [{ text, startTime: 0, endTime: 99999, id: 'dom-deep-' + Date.now() }],
                  source: 'dom-deep',
                  element: el
                });
              }
              return;
            }
          }
        }
      }
    };

    this.observer = new MutationObserver(() => {
      checkSubtitles();
    });
    this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    this.domCheckInterval = setInterval(checkSubtitles, 100);
  }

  _monitorVideoSrc() {
    if (!this.video) return;
    let lastSrc = this.video.src;
    let lastCurrentSrc = this.video.currentSrc;
    this._videoSrcInterval = setInterval(() => {
      if (this.video && (this.video.src !== lastSrc || this.video.currentSrc !== lastCurrentSrc)) {
        lastSrc = this.video.src;
        lastCurrentSrc = this.video.currentSrc;
        this.lastText = '';
        this.currentCues = [];
        this.lastCuesJson = '';
        this.capturedSubtitleContent = null;
        this.cueHistory.clear();
        console.log('[JDS] Video source changed');
        this._emit('videoChanged', { src: lastSrc });
      }
    }, 1000);
  }

  _monitorSubtitleButton() {
    this._subtitleButtonListener = (e) => {
      const target = e.target.closest('button, .button, [role="button"], .listItem, .navMenuOption');
      if (target) {
        const text = target.textContent || target.title || target.getAttribute('aria-label') || '';
        if (/subtitle|caption|\u5b57\u5e55/i.test(text)) {
          console.log('[JDS] Subtitle-related button clicked');
          setTimeout(() => this._checkTextTracks(), 800);
          setTimeout(() => this._checkActiveCues(), 1200);
        }
      }
    };
    document.addEventListener('click', this._subtitleButtonListener, true);
  }

  _emit(event, data) {
    window.dispatchEvent(new CustomEvent(`jds-${event}`, { detail: data }));
  }

  getCurrentTime() {
    return this.video ? this.video.currentTime : 0;
  }

  getParsedCues() {
    if (!this.capturedSubtitleContent) return null;
    return SubtitleParser.parse(this.capturedSubtitleContent, this.subtitleFormat);
  }
}

if (typeof window !== 'undefined') {
  window.JellyfinSubtitleCapturer = JellyfinSubtitleCapturer;
}
