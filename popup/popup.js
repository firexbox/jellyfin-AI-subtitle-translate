document.addEventListener('DOMContentLoaded', async () => {
  const els = {
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    toggleBtn: document.getElementById('toggleBtn'),
    settingsBtn: document.getElementById('settingsBtn'),
    saveSrtBtn: document.getElementById('saveSrtBtn'),
    statTranslated: document.getElementById('statTranslated'),
    statCached: document.getElementById('statCached'),
    statErrors: document.getElementById('statErrors'),
    errorMsg: document.getElementById('errorMsg'),
    hideOriginalCb: document.getElementById('hideOriginalCb'),
    translateAllCb: document.getElementById('translateAllCb')
  };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  let pollTimer = null;
  let isPolling = false;

  async function getStatus() {
    try {
      return await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });
    } catch (e) {
      return null;
    }
  }

  async function getSettings() {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getSettings' });
      return response?.settings || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Check if FULL-SET translation (translateAll) is actively in progress.
   */
  function isTranslationActive(status) {
    if (!status) return false;
    if (!status.translateAll) return false;

    const queue = status.preTranslateQueue || 0;
    const totalUnique = status.preTranslateTotalUnique || 0;
    const completed = status.preTranslateCompleted || 0;

    // Active if queue has items OR workers are processing (completed < totalUnique)
    if (queue > 0) return true;
    if (totalUnique > 0 && completed < totalUnique) return true;

    return false;
  }

  /**
   * Check if FULL-SET translation is fully complete.
   * TRUE only when every unique text the engine knows about has been translated.
   */
  function isTranslationComplete(status) {
    if (!status) return false;
    if (!status.translateAll) return false;

    const totalUnique = status.preTranslateTotalUnique || 0;
    const completed = status.preTranslateCompleted || 0;
    const queue = status.preTranslateQueue || 0;

    // Must know how many to translate, and have translated them all, with nothing left in queue
    return totalUnique > 0 && completed >= totalUnique && queue === 0;
  }

  /**
   * Build a status text showing real-time playback subtitle stats.
   */
  function buildRealtimeStatusText(status) {
    if (!status) return '未检测到页面';

    const stats = status.stats || {};
    const translated = stats.translated || 0;
    const cached = stats.cached || 0;
    const errors = stats.errors || 0;
    const liveCount = status.liveCueCount || 0;

    if (!status.enabled) {
      return status.hasVideo ? '双语字幕已关闭' : '未检测到视频';
    }

    if (!status.hasVideo) {
      return '未检测到视频';
    }

    const parts = [];
    parts.push(`已翻译 ${translated} 条`);
    if (cached > 0) parts.push(`缓存 ${cached} 条`);
    if (errors > 0) parts.push(`错误 ${errors} 条`);
    if (liveCount > 0) parts.push(`当前 ${liveCount} 条字幕`);

    return parts.join('，');
  }

  /**
   * Build full-set translation progress text.
   */
  function buildProgressText(status) {
    const completed = status.preTranslateCompleted || 0;
    const totalUnique = status.preTranslateTotalUnique || 0;
    const totalCues = status.totalCues || 0;
    const queue = status.preTranslateQueue || 0;
    const progress = status.preTranslateProgress || 0;

    if (totalUnique > 0) {
      if (queue > 0) {
        return `正在翻译全集字幕 (${progress}%，已翻译 ${completed}/${totalUnique} 条，剩余 ${queue} 条)...`;
      } else if (completed >= totalUnique) {
        return `全集翻译完成 (${completed}/${totalUnique} 条已翻译，共 ${totalCues} 条字幕)，可以保存了`;
      } else {
        return `正在准备字幕翻译 (${completed}/${totalUnique} 条)...`;
      }
    } else {
      // Engine hasn't counted yet but we know there are cues
      return `正在准备字幕翻译 (共 ${totalCues} 条字幕)...`;
    }
  }

  /**
   * Start polling for FULL-SET translation progress.
   */
  function startProgressPolling() {
    if (isPolling) return;
    isPolling = true;
    els.saveSrtBtn.disabled = true;

    const doPoll = async () => {
      const status = await getStatus();

      if (!status) {
        els.statusText.textContent = '连接已断开';
        stopProgressPolling();
        return;
      }

      // Update status text with full-set progress
      els.statusText.textContent = buildProgressText(status);
      els.statusDot.className = 'status-dot active';

      // Update stats numbers
      if (status.stats) {
        els.statTranslated.textContent = status.stats.translated || 0;
        els.statCached.textContent = status.stats.cached || 0;
        els.statErrors.textContent = status.stats.errors || 0;
      }

      // Continue polling if still active
      if (isTranslationActive(status)) {
        pollTimer = setTimeout(doPoll, 1500);
      } else {
        // Full-set translation complete or stopped
        stopProgressPolling();
        if (isTranslationComplete(status)) {
          els.saveSrtBtn.disabled = false;
          els.statusText.textContent = buildProgressText(status);
        } else {
          els.saveSrtBtn.disabled = false;
          els.statusText.textContent = buildRealtimeStatusText(status);
        }
      }
    };

    doPoll();
  }

  function stopProgressPolling() {
    isPolling = false;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function updateUI(status, settings) {
    if (!status) {
      els.statusDot.className = 'status-dot';
      els.statusText.textContent = '未检测到页面';
      els.toggleBtn.style.display = 'none';
      els.hideOriginalCb.parentElement.style.display = 'none';
      els.translateAllCb.parentElement.style.display = 'none';
      els.saveSrtBtn.style.display = 'none';
      return;
    }

    els.toggleBtn.style.display = 'block';
    els.hideOriginalCb.parentElement.style.display = 'flex';
    els.translateAllCb.parentElement.style.display = 'flex';
    els.saveSrtBtn.style.display = 'block';

    // Update checkbox states from settings
    if (settings) {
      els.hideOriginalCb.checked = !!settings.hideOriginal;
      els.translateAllCb.checked = !!settings.translateAll;
    }

    // Update stats numbers
    if (status.stats) {
      els.statTranslated.textContent = status.stats.translated || 0;
      els.statCached.textContent = status.stats.cached || 0;
      els.statErrors.textContent = status.stats.errors || 0;
    }

    // Case 1: Full-set translation is actively running -> show progress
    if (isTranslationActive(status)) {
      startProgressPolling();
      return;
    }

    // Case 2: Full-set translation is complete -> show completion
    if (isTranslationComplete(status)) {
      els.statusDot.className = 'status-dot active';
      els.statusText.textContent = buildProgressText(status);
      els.toggleBtn.textContent = status.enabled ? '关闭双语字幕' : '开启双语字幕';
      return;
    }

    // Case 3: Normal playback mode -> show real-time translation stats
    els.statusDot.className = status.enabled ? 'status-dot active' : 'status-dot inactive';
    els.statusText.textContent = buildRealtimeStatusText(status);
    els.toggleBtn.textContent = status.enabled ? '关闭双语字幕' : '开启双语字幕';
  }

  els.toggleBtn.addEventListener('click', async () => {
    const status = await getStatus();
    if (!status) return;

    const action = status.enabled ? 'disable' : 'enable';
    try {
      await chrome.tabs.sendMessage(tab.id, { action });
      setTimeout(async () => {
        const newStatus = await getStatus();
        const newSettings = await getSettings();
        updateUI(newStatus, newSettings);
      }, 300);
    } catch (e) {
      els.errorMsg.textContent = '操作失败: ' + e.message;
      els.errorMsg.style.display = 'block';
    }
  });

  els.hideOriginalCb.addEventListener('change', async () => {
    const checked = els.hideOriginalCb.checked;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'updateSettings',
        settings: { hideOriginal: checked }
      });
    } catch (e) {
      els.errorMsg.textContent = '设置失败: ' + e.message;
      els.errorMsg.style.display = 'block';
    }
  });

  els.translateAllCb.addEventListener('change', async () => {
    const checked = els.translateAllCb.checked;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'updateSettings',
        settings: { translateAll: checked }
      });
      if (checked) {
        await chrome.tabs.sendMessage(tab.id, { action: 'translateAll' });
        startProgressPolling();
      }
    } catch (e) {
      els.errorMsg.textContent = '设置失败: ' + e.message;
      els.errorMsg.style.display = 'block';
    }
  });

  els.saveSrtBtn.addEventListener('click', async () => {
    try {
      els.errorMsg.style.display = 'none';

      const status = await getStatus();
      const hasCues = status?.hasCues || false;
      const completed = status?.preTranslateCompleted || 0;
      const totalUnique = status?.preTranslateTotalUnique || 0;
      const queue = status?.preTranslateQueue || 0;

      if (!hasCues) {
        els.errorMsg.textContent = '未找到字幕数据，请确保视频已加载字幕';
        els.errorMsg.style.display = 'block';
        return;
      }

      // TRUE complete: translateAll mode + all unique texts translated + queue empty
      const isFullyTranslated = status.translateAll && totalUnique > 0 && completed >= totalUnique && queue === 0;

      if (!isFullyTranslated) {
        // Enable translateAll and trigger full-set translation
        els.translateAllCb.checked = true;
        els.saveSrtBtn.disabled = true;

        await chrome.tabs.sendMessage(tab.id, {
          action: 'updateSettings',
          settings: { translateAll: true }
        });
        await chrome.tabs.sendMessage(tab.id, { action: 'translateAll' });

        startProgressPolling();
        return;
      }

      // Translation complete - proceed to save
      els.saveSrtBtn.textContent = '保存中...';
      els.saveSrtBtn.disabled = true;

      const response = await chrome.tabs.sendMessage(tab.id, { action: 'saveSubtitles' });
      if (response?.success) {
        els.statusText.textContent = '双语字幕已保存: ' + (response.filename || 'subtitles.srt');
        els.statusDot.className = 'status-dot active';
      } else {
        els.errorMsg.textContent = '保存失败: ' + (response?.error || '未知错误');
        els.errorMsg.style.display = 'block';
      }
    } catch (err) {
      els.errorMsg.textContent = '保存失败: ' + err.message;
      els.errorMsg.style.display = 'block';
    } finally {
      if (!isPolling) {
        els.saveSrtBtn.textContent = '保存双语字幕为 SRT';
        els.saveSrtBtn.disabled = false;
      }
    }
  });

  els.settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Initial load
  const status = await getStatus();
  const settings = await getSettings();
  updateUI(status, settings);
});
