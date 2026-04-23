/**
 * OriginalSubtitleHider
 * Force-hides Jellyfin's native/original subtitle elements via MutationObserver.
 * CSS alone is not enough because Jellyfin uses inline styles and dynamic DOM.
 */

class OriginalSubtitleHider {
  constructor() {
    this.observer = null;
    this.hideSelectors = [
      '.subtitleContainer',
      '.videoSubtitles',
      '.subtitle-text',
      '.subtitleBubble',
      '.subtitle-overlay',
      '.subtitle-wrapper',
      '.vjs-text-track-display',
      '.vjs-text-track-cue',
      '.shaka-text-container',
      '.bmpui-ui-subtitle-overlay',
      '.videoPlayerContainer .subtitle',
      '.videoPlayerContainer [class*="subtitle"]',
      '.videoPlayerContainer [class*="caption"]',
      '.videoPlayerContainer [class*="Subtitle"]',
      '.videoPlayerContainer [class*="Caption"]',
      '.videoPlayerContainer .vtt',
      '.videoPlayerContainer .textTrack'
    ];
    this.isRunning = false;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[JDS] OriginalSubtitleHider started');

    // Immediately hide existing elements
    this._hideAll();

    // Watch for new elements
    this.observer = new MutationObserver((mutations) => {
      let needsHide = false;
      for (const m of mutations) {
        if (m.type === 'childList' && m.addedNodes.length > 0) {
          needsHide = true;
          break;
        }
      }
      if (needsHide) this._hideAll();
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Periodic sweep as fallback
    this._sweepInterval = setInterval(() => this._hideAll(), 500);
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    console.log('[JDS] OriginalSubtitleHider stopped');

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this._sweepInterval) {
      clearInterval(this._sweepInterval);
      this._sweepInterval = null;
    }

    // Restore visibility
    this._restoreAll();
  }

  _hideAll() {
    for (const sel of this.hideSelectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          // Skip our own subtitle container
          if (el.id === 'jds-dual-subtitle-host' || el.closest('#jds-dual-subtitle-host')) continue;

          // Check if already hidden by us
          if (el._jdsHiddenByHider) continue;

          // Save original styles
          el._jdsOriginalDisplay = el.style.display;
          el._jdsOriginalOpacity = el.style.opacity;
          el._jdsOriginalVisibility = el.style.visibility;
          el._jdsHiddenByHider = true;

          // Force hide
          el.style.setProperty('display', 'none', 'important');
          el.style.setProperty('opacity', '0', 'important');
          el.style.setProperty('visibility', 'hidden', 'important');
        }
      } catch (e) {}
    }

    // Also try to hide native text tracks by forcing mode to hidden
    const videos = document.querySelectorAll('video');
    for (const video of videos) {
      if (video.textTracks) {
        for (let i = 0; i < video.textTracks.length; i++) {
          const track = video.textTracks[i];
          if (track.mode === 'showing') {
            track._jdsOriginalMode = 'showing';
            track.mode = 'hidden';
          }
        }
      }
    }
  }

  _restoreAll() {
    for (const sel of this.hideSelectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (!el._jdsHiddenByHider) continue;

          if (el._jdsOriginalDisplay !== undefined) {
            el.style.display = el._jdsOriginalDisplay;
          } else {
            el.style.removeProperty('display');
          }

          if (el._jdsOriginalOpacity !== undefined) {
            el.style.opacity = el._jdsOriginalOpacity;
          } else {
            el.style.removeProperty('opacity');
          }

          if (el._jdsOriginalVisibility !== undefined) {
            el.style.visibility = el._jdsOriginalVisibility;
          } else {
            el.style.removeProperty('visibility');
          }

          delete el._jdsHiddenByHider;
          delete el._jdsOriginalDisplay;
          delete el._jdsOriginalOpacity;
          delete el._jdsOriginalVisibility;
        }
      } catch (e) {}
    }

    // Restore text track modes
    const videos = document.querySelectorAll('video');
    for (const video of videos) {
      if (video.textTracks) {
        for (let i = 0; i < video.textTracks.length; i++) {
          const track = video.textTracks[i];
          if (track._jdsOriginalMode === 'showing') {
            track.mode = 'showing';
            delete track._jdsOriginalMode;
          }
        }
      }
    }
  }
}

if (typeof window !== 'undefined') {
  window.OriginalSubtitleHider = OriginalSubtitleHider;
}
