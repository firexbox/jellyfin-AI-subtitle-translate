/**
 * Jellyfin Dual Subtitle - Main Inject Script
 * Continuous pre-translation engine: monitors cue list growth, retries failures, restarts on seek
 */

(function() {
  'use strict';
  if (window.__jellyfinDualSubtitle) return;
  window.__jellyfinDualSubtitle = true;

  const JDS = {
    enabled: false,
    settings: {},
    capturer: null,
    renderer: null,
    stats: { translated: 0, cached: 0, errors: 0 },
    debug: true,
    preTranslatedCues: null,
    allCuesFromTrack: null,
    isPreTranslating: false,
    preTranslateProgress: 0,
    renderLoopId: null,
    pendingTranslates: new Set(),
    lastOriginal: '',
    lastTranslated: '',
    lastTickTime: 0,
    originalHider: null,
    // Pre-translation engine state
    preTranslate: {
      queue: [],           // texts waiting to be translated
      failed: new Map(),   // text -> retryCount
      completed: new Set(),// texts successfully translated
      totalUnique: 0,      // total unique texts to translate
      isRunning: false,
      workers: [],
      lastCueCount: 0,     // track cue list growth
      lastSeekTime: 0,     // last time we detected a seek
      phase: 'none',       // 'none' | 'future' | 'past' | 'all'
      futureTexts: new Set(), // texts in future phase
      pastTexts: new Set(),   // texts in past phase
      allTexts: new Set()     // all texts ever seen
    }
  };

  const DEFAULT_SETTINGS = {
    enabled: false, provider: 'openai', apiKey: '', apiUrl: '', model: '',
    targetLang: 'zh-CN', position: 'top', fontSize: 20, hideOriginal: false,
    batchSize: 1, concurrency: 3, rateLimitMs: 200,
    autoTranslateOnLoad: true,
    placeholderText: '...',
    maxRetries: 3,
    translateAll: false
  };

  function log(...args) {
    if (JDS.debug) console.log('[JDS]', ...args);
  }

  async function init() {
    log('Initializing v6 (continuous pre-translate)...');
    JDS.settings = await loadSettings();
    JDS.enabled = JDS.settings.enabled;

    const video = await waitForVideo();
    if (!video) {
      setTimeout(init, 3000);
      return;
    }

    log('Video found');
    JDS.currentVideo = video;
    setupCapturer(video);
    setupRenderer(video);

    if (JDS.enabled) {
      enableDualSubtitle();
    }

    observeVideoChanges();
    if (chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(handleMessage);
    }
    log('Init complete');
  }

  async function loadSettings() {
    return new Promise(resolve => {
      if (chrome.storage?.sync) {
        chrome.storage.sync.get(DEFAULT_SETTINGS, items => resolve({ ...DEFAULT_SETTINGS, ...items }));
      } else resolve(DEFAULT_SETTINGS);
    });
  }

  async function saveSettings(settings) {
    return new Promise(resolve => {
      if (chrome.storage?.sync) chrome.storage.sync.set(settings, resolve);
      else resolve();
    });
  }

  function waitForVideo() {
    return new Promise(resolve => {
      const v = findVideo();
      if (v) return resolve(v);
      let attempts = 0;
      const check = () => {
        const video = findVideo();
        if (video) { observer.disconnect(); clearInterval(timer); resolve(video); }
        if (++attempts > 60) { observer.disconnect(); clearInterval(timer); resolve(null); }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true });
      const timer = setInterval(check, 1000);
      setTimeout(() => { observer.disconnect(); clearInterval(timer); resolve(null); }, 60000);
    });
  }

  function findVideo() {
    const videos = document.querySelectorAll('video');
    for (const v of videos) {
      const rect = v.getBoundingClientRect();
      if (rect.width > 200 && rect.height > 100) {
        const style = window.getComputedStyle(v);
        if (style.display !== 'none' && parseFloat(style.opacity) > 0) return v;
      }
    }
    return videos.length > 0 ? videos[0] : null;
  }

  // ------------------------------------------------------------------
  // Setup
  // ------------------------------------------------------------------

  function setupCapturer(video) {
    JDS.capturer = new JellyfinSubtitleCapturer();
    JDS.capturer.start(video);

    window.addEventListener('jds-subtitleLoaded', async (e) => {
      log('Subtitle file loaded, pre-translating...');
      const { text, format } = e.detail;
      const cues = SubtitleParser.parse(text, format);
      if (cues?.length > 0) {
        JDS.preTranslatedCues = cues;
        startContinuousPreTranslation(cues);
      }
    });
  }

  function setupRenderer(video) {
    JDS.renderer = new DualSubtitleRenderer();
    JDS.renderer.init(video, {
      position: JDS.settings.position,
      fontSize: JDS.settings.fontSize,
      targetLang: JDS.settings.targetLang
    });
  }

  // ------------------------------------------------------------------
  // Render Loop
  // ------------------------------------------------------------------

  function startRenderLoop(video) {
    if (!video) return;

    // Remove old listeners if they exist (for video element reuse)
    if (JDS._tickFn && JDS.currentVideo) {
      JDS.currentVideo.removeEventListener('timeupdate', JDS._tickFn);
    }
    if (JDS._seekInterval) {
      clearInterval(JDS._seekInterval);
      JDS._seekInterval = null;
    }

    JDS._tickFn = () => {
      if (!JDS.enabled) return;
      JDS.lastTickTime = performance.now();

      const currentTimeMs = (video.currentTime || 0) * 1000;
      let originalText = '';
      let translatedText = '';
      let hasPending = false;

      // --- Path A: Pre-translated file cues ---
      if (JDS.preTranslatedCues) {
        const matched = JDS.preTranslatedCues.filter(c =>
          c.start <= currentTimeMs && c.end >= currentTimeMs
        );
        if (matched.length > 0) {
          originalText = matched.map(c => c.text).join('\n');

          const parts = [];
          for (const cue of matched) {
            if (cue.translatedText) {
              parts.push(cue.translatedText);
            } else {
              const cached = JDS.renderer.getCached(cue.text);
              if (cached) {
                parts.push(cached);
                cue.translatedText = cached;
              } else {
                parts.push(JDS.settings.placeholderText);
                hasPending = true;
                enqueueForTranslation(cue.text);
              }
            }
          }
          translatedText = parts.join('\n');
        }
      }

      // --- Path B: Live texttrack cues ---
      if (!originalText) {
        const liveCues = JDS.capturer ? JDS.capturer.currentCues : [];
        if (liveCues.length > 0) {
          originalText = liveCues.map(c => c.text).join('\n');

          const parts = [];
          for (const cue of liveCues) {
            const cached = JDS.renderer.getCached(cue.text);
            if (cached) {
              parts.push(cached);
            } else {
              parts.push(JDS.settings.placeholderText);
              hasPending = true;
              enqueueForTranslation(cue.text);
            }
          }
          translatedText = parts.join('\n');

          // Try to extract all track cues for continuous pre-translation
          if (!JDS.allCuesFromTrack && video.textTracks?.length > 0) {
            extractAllTrackCues(video);
          }
        }
      }

      // --- Display ---
      if (originalText) {
        if (originalText !== JDS.lastOriginal || translatedText !== JDS.lastTranslated) {
          JDS.renderer.show(originalText, translatedText);
          JDS.lastOriginal = originalText;
          JDS.lastTranslated = translatedText;
        }
      } else {
        if (JDS.lastOriginal !== '' || JDS.lastTranslated !== '') {
          JDS.renderer.hide(400);
          JDS.lastOriginal = '';
          JDS.lastTranslated = '';
        }
      }

      // Fast re-tick if pending
      if (hasPending) {
        requestAnimationFrame(JDS._tickFn);
      }
    };

    video.addEventListener('timeupdate', JDS._tickFn);

    // Also monitor for seek events to restart pre-translation
    let lastTime = video.currentTime || 0;
    JDS._seekInterval = setInterval(() => {
      const now = video.currentTime || 0;
      const diff = Math.abs(now - lastTime);
      // Detect seek: time jumped more than 2 seconds in one direction
      if (diff > 2 && JDS.allCuesFromTrack) {
        log('Seek detected:', lastTime, '->', now);
        JDS.preTranslate.lastSeekTime = Date.now();
        // Restart pre-translation from new position
        startContinuousPreTranslation(JDS.allCuesFromTrack);
      }
      lastTime = now;
    }, 500);

    const rafLoop = () => {
      if (JDS.enabled) {
        if (performance.now() - JDS.lastTickTime > 33) {
          JDS._tickFn();
        }
      }
      JDS.renderLoopId = requestAnimationFrame(rafLoop);
    };
    JDS.renderLoopId = requestAnimationFrame(rafLoop);
  }

  // ------------------------------------------------------------------
  // Extract ALL cues from textTracks - with growth monitoring
  // ------------------------------------------------------------------

  async function extractAllTrackCues(video) {
    if (!video || !video.textTracks) return;

    const allCues = [];
    let cueCount = 0;
    for (let i = 0; i < video.textTracks.length; i++) {
      const track = video.textTracks[i];
      if (track.mode === 'disabled') continue;

      // Ensure track mode is not disabled so cues are populated
      if (track.mode === 'disabled') track.mode = 'hidden';

      if (track.cues) {
        cueCount += track.cues.length;
        for (let j = 0; j < track.cues.length; j++) {
          const cue = track.cues[j];
          if (cue.text) {
            allCues.push({
              text: cue.text,
              start: cue.startTime * 1000,
              end: cue.endTime * 1000,
              id: cue.id || `${cue.startTime}-${cue.endTime}`
            });
          }
        }
      }
    }

    if (allCues.length === 0) return;

    // Check if cue list has grown since last extraction
    if (cueCount <= JDS.preTranslate.lastCueCount && JDS.allCuesFromTrack) {
      return; // No new cues
    }

    log('Extracted', allCues.length, 'cues from textTracks (previous:', JDS.preTranslate.lastCueCount + ')');
    JDS.preTranslate.lastCueCount = cueCount;
    JDS.allCuesFromTrack = allCues;

    if (!JDS.preTranslatedCues) {
      JDS.preTranslatedCues = allCues;
    }

    // Start or restart continuous pre-translation
    startContinuousPreTranslation(allCues);

    // Monitor for cue list growth every 5 seconds
    setTimeout(() => extractAllTrackCues(video), 5000);
  }

  // ------------------------------------------------------------------
  // Continuous Pre-Translation Engine
  // ------------------------------------------------------------------

  function enqueueForTranslation(text) {
    if (!text) return;
    const pt = JDS.preTranslate;

    if (pt.completed.has(text)) return;
    if (pt.queue.includes(text)) return;
    if (JDS.renderer.getCached(text)) {
      pt.completed.add(text);
      return;
    }

    // Insert at appropriate position based on current phase
    // If we're in future phase, new items go to front if they're in future
    // Otherwise append to end
    const currentTimeMs = (JDS.currentVideo?.currentTime || 0) * 1000;
    const cue = findCueByText(text);
    const isFuture = cue ? cue.start >= currentTimeMs : true;

    if (pt.phase === 'future' && isFuture) {
      // Insert at beginning (high priority)
      pt.queue.unshift(text);
    } else {
      pt.queue.push(text);
    }

    // Wake up workers if sleeping
    if (!pt.isRunning && pt.queue.length > 0) {
      const allCues = JDS.allCuesFromTrack || JDS.preTranslatedCues;
      if (allCues) startContinuousPreTranslation(allCues);
    }
  }

  function findCueByText(text) {
    const cues = JDS.preTranslatedCues || JDS.allCuesFromTrack || [];
    return cues.find(c => c.text === text);
  }

  /**
   * Phase-aware continuous pre-translation
   * Phase 1: Translate future cues (currentTime -> end)
   * Phase 2: After future is done, translate past cues (start -> currentTime)
   * Phase 3: All done -> assemble complete bilingual subtitle
   */
  async function startContinuousPreTranslation(cues, forcePhase = null) {
    if (!cues || cues.length === 0) return;

    const pt = JDS.preTranslate;
    const currentTimeMs = (JDS.currentVideo?.currentTime || 0) * 1000;

    // Determine phase
    let targetPhase = forcePhase;
    if (!targetPhase) {
      if (pt.phase === 'none' || pt.phase === 'future') {
        targetPhase = 'future';
      } else if (pt.phase === 'past') {
        targetPhase = 'past';
      } else {
        targetPhase = 'all';
      }
    }
    pt.phase = targetPhase;

    // Split cues by time
    const futureCues = cues.filter(c => c.start >= currentTimeMs);
    const pastCues = cues.filter(c => c.start < currentTimeMs);

    // Track text sets for each phase
    const futureTexts = [...new Set(futureCues.map(c => c.text))];
    const pastTexts = [...new Set(pastCues.map(c => c.text))];
    futureTexts.forEach(t => pt.allTexts.add(t));
    pastTexts.forEach(t => pt.allTexts.add(t));

    // Determine which texts to translate in this phase
    let targetTexts = [];
    if (targetPhase === 'future') {
      targetTexts = futureTexts;
      futureTexts.forEach(t => pt.futureTexts.add(t));
      log('Phase 1: Translating', targetTexts.length, 'future cues (from', Math.round(currentTimeMs/1000), 's)');
    } else if (targetPhase === 'past') {
      targetTexts = pastTexts;
      pastTexts.forEach(t => pt.pastTexts.add(t));
      log('Phase 2: Translating', targetTexts.length, 'past cues (before', Math.round(currentTimeMs/1000), 's)');
    } else {
      targetTexts = [...new Set(cues.map(c => c.text))];
      log('Full translation:', targetTexts.length, 'unique texts');
    }

    // Filter out already completed/cached
    const textsToQueue = [];
    for (const text of targetTexts) {
      if (!pt.completed.has(text) && !pt.queue.includes(text) && !JDS.renderer.getCached(text)) {
        textsToQueue.push(text);
      }
    }

    // Sort queue by time: future ascending, past descending from currentTime
    textsToQueue.sort((a, b) => {
      const cueA = cues.find(c => c.text === a);
      const cueB = cues.find(c => c.text === b);
      if (!cueA || !cueB) return 0;
      const distA = Math.abs(cueA.start - currentTimeMs);
      const distB = Math.abs(cueB.start - currentTimeMs);
      return distA - distB; // Sort by distance from current time (nearest first)
    });

    for (const text of textsToQueue) {
      pt.queue.push(text);
    }

    pt.totalUnique = pt.allTexts.size;

    if (pt.queue.length === 0) {
      // This phase is complete
      if (targetPhase === 'future' && pastTexts.length > 0) {
        log('Phase 1 complete. Starting Phase 2 (past cues)...');
        pt.phase = 'past';
        startContinuousPreTranslation(cues, 'past');
        return;
      } else if (targetPhase === 'past' || targetPhase === 'all') {
        log('All phases complete!');
        pt.phase = 'all';
        JDS.preTranslateProgress = 100;
        window.dispatchEvent(new CustomEvent('jds-preTranslationComplete', { detail: { cues } }));
        return;
      }
    }

    if (pt.isRunning) {
      log('Workers running, queued', textsToQueue.length, 'items (phase:', targetPhase + ')');
      return;
    }

    pt.isRunning = true;
    log('Starting workers:', pt.queue.length, 'items, phase:', targetPhase);

    async function worker() {
      while (pt.queue.length > 0) {
        const nowMs = (JDS.currentVideo?.currentTime || 0) * 1000;

        if (Date.now() - pt.lastSeekTime < 1000) {
          await new Promise(r => setTimeout(r, 200));
          continue;
        }

        const text = pt.queue.shift();
        if (!text) continue;

        if (pt.completed.has(text) || JDS.renderer.getCached(text)) {
          pt.completed.add(text);
          continue;
        }

        await new Promise(r => setTimeout(r, JDS.settings.rateLimitMs));

        const retryCount = pt.failed.get(text) || 0;
        if (retryCount >= JDS.settings.maxRetries) {
          pt.failed.delete(text);
          continue;
        }

        try {
          const controller = new AbortController();
          const results = await AIProviders.translate(JDS.settings, [text], controller.signal);
          const translated = results[0];

          if (translated && translated !== text) {
            JDS.renderer.setCache(text, translated);
            JDS.stats.translated++;
            pt.completed.add(text);
            pt.failed.delete(text);

            for (const cue of cues) {
              if (cue.text === text) cue.translatedText = translated;
            }

            if (JDS.lastOriginal && JDS.lastOriginal.includes(text)) {
              JDS.lastTranslated = '';
            }
          }
        } catch (err) {
          const newRetryCount = retryCount + 1;
          pt.failed.set(text, newRetryCount);
          if (newRetryCount < JDS.settings.maxRetries) {
            setTimeout(() => {
              if (!pt.completed.has(text) && !JDS.renderer.getCached(text)) {
                pt.queue.push(text);
              }
            }, Math.pow(2, newRetryCount) * 1000);
          }
        }

        JDS.preTranslateProgress = Math.min(100, Math.round((pt.completed.size / Math.max(1, pt.totalUnique)) * 100));
      }
    }

    pt.workers = [];
    for (let i = 0; i < JDS.settings.concurrency; i++) {
      pt.workers.push(worker());
    }
    await Promise.all(pt.workers);

    pt.isRunning = false;
    pt.workers = [];

    // Check if phase transition needed
    if (pt.queue.length === 0) {
      if (pt.phase === 'future') {
        const hasPast = pastTexts.some(t => !pt.completed.has(t) && !JDS.renderer.getCached(t));
        if (hasPast) {
          log('Phase 1 workers idle. Starting Phase 2...');
          startContinuousPreTranslation(cues, 'past');
          return;
        }
      }
      log('Workers idle. Phase:', pt.phase, 'Completed:', pt.completed.size, 'Total:', pt.totalUnique);

      // If all done
      if (pt.completed.size >= pt.totalUnique && pt.totalUnique > 0) {
        pt.phase = 'all';
        JDS.preTranslateProgress = 100;
        window.dispatchEvent(new CustomEvent('jds-preTranslationComplete', { detail: { cues } }));
      }
    } else {
      log('Queue grew during translation, restarting...');
      startContinuousPreTranslation(cues, pt.phase);
    }
  }

  // ------------------------------------------------------------------
  // Real-time single translation (fallback)
  // ------------------------------------------------------------------

  async function translateText(text) {
    if (!text || JDS.pendingTranslates.has(text)) return;
    JDS.pendingTranslates.add(text);

    try {
      const controller = new AbortController();
      const results = await AIProviders.translate(JDS.settings, [text], controller.signal);
      const translated = results[0];

      if (translated && translated !== text) {
        JDS.renderer.setCache(text, translated);
        JDS.stats.translated++;

        // Mark as completed in pre-translate engine
        JDS.preTranslate.completed.add(text);

        if (JDS.lastOriginal && JDS.lastOriginal.includes(text)) {
          JDS.lastTranslated = '';
        }
      }
    } catch (err) {
      JDS.stats.errors++;
    } finally {
      JDS.pendingTranslates.delete(text);
    }
  }

  // ------------------------------------------------------------------
  // Enable / Disable
  // ------------------------------------------------------------------

  function enableDualSubtitle() {
    JDS.enabled = true;
    if (JDS.renderer) {
      JDS.renderer.updateSettings({
        position: JDS.settings.position,
        fontSize: JDS.settings.fontSize,
        targetLang: JDS.settings.targetLang
      });
    }

    if (!JDS.renderLoopId && JDS.currentVideo) {
      startRenderLoop(JDS.currentVideo);
    }

    if (JDS.settings.hideOriginal) {
      if (!JDS.originalHider) {
        JDS.originalHider = document.createElement('style');
        JDS.originalHider.textContent = `
          video::cue { opacity: 0 !important; }
          .subtitleContainer, .videoSubtitles, .subtitle-text { opacity: 0 !important; }
        `;
        document.head.appendChild(JDS.originalHider);
      }
    }
    log('Dual subtitle enabled');
  }

  function disableDualSubtitle() {
    JDS.enabled = false;
    if (JDS.renderer) JDS.renderer.hide();
    if (JDS.renderLoopId) {
      cancelAnimationFrame(JDS.renderLoopId);
      JDS.renderLoopId = null;
    }
    if (JDS.originalHider && JDS.originalHider.parentElement) {
      JDS.originalHider.parentElement.removeChild(JDS.originalHider);
      JDS.originalHider = null;
    }
    JDS.lastOriginal = '';
    JDS.lastTranslated = '';
    log('Dual subtitle disabled');
  }

  function observeVideoChanges() {
    // Detect video element replacement (DOM changes)
    const domObserver = new MutationObserver(() => {
      const video = findVideo();
      if (video && video !== JDS.currentVideo) {
        log('Video element changed, reinitializing...');
        resetForNewEpisode(video);
      }
    });
    domObserver.observe(document.body, { childList: true, subtree: true });

    // Detect video.src / currentSrc changes (same element, new source)
    // This is critical for Jellyfin SPA where the video element is reused
    let lastSrc = '';
    let lastCurrentSrc = '';
    let lastTitle = document.title;
    let lastUrl = location.href;

    setInterval(() => {
      const video = JDS.currentVideo;
      if (!video) return;

      const currentSrc = video.currentSrc || video.src || '';
      const srcChanged = currentSrc !== lastCurrentSrc && currentSrc !== '';
      const titleChanged = document.title !== lastTitle;
      const urlChanged = location.href !== lastUrl;

      if (srcChanged || titleChanged || urlChanged) {
        log('Episode change detected:', {
          srcChanged: srcChanged ? `${lastCurrentSrc.slice(-40)} -> ${currentSrc.slice(-40)}` : false,
          titleChanged: titleChanged ? `${lastTitle} -> ${document.title}` : false,
          urlChanged: urlChanged ? `${lastUrl} -> ${location.href}` : false
        });
        lastCurrentSrc = currentSrc;
        lastSrc = video.src || '';
        lastTitle = document.title;
        lastUrl = location.href;
        resetForNewEpisode(video);
      }
    }, 1000);

    // Also listen for popstate (back/forward navigation in SPA)
    window.addEventListener('popstate', () => {
      log('Popstate detected, checking for episode change...');
      const video = findVideo();
      if (video) resetForNewEpisode(video);
    });

    // Listen for Jellyfin's custom page transition events if available
    window.addEventListener('beforeunload', () => {
      lastCurrentSrc = '';
      lastSrc = '';
    });
  }

  function resetForNewEpisode(video) {
    log('Resetting for new episode...');

    // Stop render loop
    if (JDS.renderLoopId) {
      cancelAnimationFrame(JDS.renderLoopId);
      JDS.renderLoopId = null;
    }

    // Remove timeupdate listener from old video
    if (JDS._tickFn && JDS.currentVideo) {
      JDS.currentVideo.removeEventListener('timeupdate', JDS._tickFn);
      JDS._tickFn = null;
    }

    // Clear seek interval
    if (JDS._seekInterval) {
      clearInterval(JDS._seekInterval);
      JDS._seekInterval = null;
    }

    // Stop capturer
    if (JDS.capturer) {
      JDS.capturer.stop();
      JDS.capturer = null;
    }

    // Destroy renderer and clear cache
    if (JDS.renderer) {
      JDS.renderer.hide();
      JDS.renderer.clearCache();
      JDS.renderer.destroy();
      JDS.renderer = null;
    }

    // Reset all state
    JDS.currentVideo = video;
    JDS.preTranslatedCues = null;
    JDS.allCuesFromTrack = null;
    JDS.preTranslate.queue = [];
    JDS.preTranslate.completed.clear();
    JDS.preTranslate.failed.clear();
    JDS.preTranslate.lastCueCount = 0;
    JDS.preTranslate.totalUnique = 0;
    JDS.preTranslate.phase = 'none';
    JDS.preTranslate.futureTexts.clear();
    JDS.preTranslate.pastTexts.clear();
    JDS.preTranslate.allTexts.clear();
    JDS.preTranslateProgress = 0;
    JDS.lastOriginal = '';
    JDS.lastTranslated = '';
    JDS.pendingTranslates.clear();

    // Re-setup
    setupCapturer(video);
    setupRenderer(video);
    startRenderLoop(video);

    if (JDS.enabled) {
      enableDualSubtitle();
    }

    log('New episode initialization complete');
  }

  // ------------------------------------------------------------------
  // SRT Export Helpers
  // ------------------------------------------------------------------

  function formatSRTTime(ms) {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const millis = Math.floor(ms % 1000);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
  }

  function generateBilingualSRT(cues) {
    const lines = [];
    let index = 1;
    for (const cue of cues) {
      const translated = cue.translatedText || JDS.renderer.getCached(cue.text) || '';
      lines.push(index++);
      lines.push(`${formatSRTTime(cue.start)} --> ${formatSRTTime(cue.end)}`);
      lines.push(cue.text);
      if (translated && translated !== cue.text) {
        lines.push(translated);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  function downloadSRT(content, filename) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ------------------------------------------------------------------
  // Message Handler
  // ------------------------------------------------------------------

  function handleMessage(request, sender, sendResponse) {
    switch (request.action) {
      case 'getStatus': {
        const allCues = JDS.preTranslatedCues || JDS.allCuesFromTrack || [];
        const hasCues = allCues.length > 0;
        const liveCues = JDS.capturer ? JDS.capturer.currentCues : [];
        const liveCueCount = liveCues.length;
        // totalUnique = how many unique texts the engine knows it should translate
        const totalUnique = JDS.preTranslate.totalUnique || 0;
        sendResponse({
          enabled: JDS.enabled,
          hasVideo: !!JDS.currentVideo,
          stats: JDS.stats,
          preTranslateProgress: JDS.preTranslateProgress,
          preTranslateQueue: JDS.preTranslate.queue.length,
          preTranslateCompleted: JDS.preTranslate.completed.size,
          preTranslateTotalUnique: totalUnique,
          hasCues: hasCues,
          totalCues: allCues.length,
          translateAll: JDS.settings.translateAll || false,
          liveCueCount: liveCueCount
        });
        break;
      }
      case 'enable':
        enableDualSubtitle();
        saveSettings({ ...JDS.settings, enabled: true });
        sendResponse({ success: true });
        break;
      case 'disable':
        disableDualSubtitle();
        saveSettings({ ...JDS.settings, enabled: false });
        sendResponse({ success: true });
        break;
      case 'updateSettings':
        JDS.settings = { ...JDS.settings, ...request.settings };
        saveSettings(JDS.settings);
        if (JDS.renderer) JDS.renderer.updateSettings({
          position: JDS.settings.position, fontSize: JDS.settings.fontSize, targetLang: JDS.settings.targetLang
        });
        if (JDS.settings.hideOriginal) {
          if (!JDS.originalHider) {
            JDS.originalHider = document.createElement('style');
            JDS.originalHider.textContent = `video::cue { opacity: 0 !important; }`;
            document.head.appendChild(JDS.originalHider);
          }
        } else if (JDS.originalHider) {
          JDS.originalHider.parentElement.removeChild(JDS.originalHider);
          JDS.originalHider = null;
        }
        sendResponse({ success: true });
        break;
      case 'getSettings':
        sendResponse({ settings: JDS.settings });
        break;
      case 'saveSubtitles': {
        const cues = JDS.preTranslatedCues || JDS.allCuesFromTrack || [];
        if (cues.length === 0) {
          sendResponse({ success: false, error: '未找到字幕数据' });
          return true;
        }
        const srtContent = generateBilingualSRT(cues);
        const filename = `bilingual_${Date.now()}.srt`;
        downloadSRT(srtContent, filename);
        sendResponse({ success: true, immediate: true, filename });
        break;
      }
      case 'translateAll': {
        const allCues = JDS.preTranslatedCues || JDS.allCuesFromTrack || [];
        if (allCues.length > 0) {
          // Force full translation (all phases)
          startContinuousPreTranslation(allCues, 'all');
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: '无字幕可翻译' });
        }
        break;
      }
      default:
        sendResponse({ success: false, error: '未知操作: ' + request.action });
        break;
    }
    return true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
