document.addEventListener('DOMContentLoaded', async () => {
  const els = {
    provider: document.getElementById('provider'),
    apiKey: document.getElementById('apiKey'),
    apiUrl: document.getElementById('apiUrl'),
    apiUrlGroup: document.getElementById('apiUrlGroup'),
    model: document.getElementById('model'),
    targetLang: document.getElementById('targetLang'),
    position: document.getElementById('position'),
    fontSize: document.getElementById('fontSize'),
    enabledToggle: document.getElementById('enabledToggle'),
    saveBtn: document.getElementById('saveBtn'),
    testBtn: document.getElementById('testBtn'),
    saveAlert: document.getElementById('saveAlert'),
    testAlert: document.getElementById('testAlert')
  };

  const providerModels = {
    openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
    gemini: ['gemini-2.0-flash-lite', 'gemini-2.0-flash', 'gemini-1.5-flash'],
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
    custom: []
  };

  // Load settings
  async function loadSettings() {
    const defaults = {
      enabled: false,
      provider: 'openai',
      apiKey: '',
      apiUrl: '',
      model: '',
      targetLang: 'zh-CN',
      position: 'top',
      fontSize: 20,
      hideOriginal: false
    };
    const items = await chrome.storage.sync.get(defaults);
    return { ...defaults, ...items };
  }

  const settings = await loadSettings();

  // Populate form
  els.provider.value = settings.provider;
  els.apiKey.value = settings.apiKey;
  els.apiUrl.value = settings.apiUrl;
  els.targetLang.value = settings.targetLang;
  els.position.value = settings.position;
  els.fontSize.value = settings.fontSize;
  if (settings.enabled) els.enabledToggle.classList.add('active');

  updateModelOptions(settings.provider, settings.model);
  updateApiUrlVisibility(settings.provider);

  function updateModelOptions(provider, selectedModel) {
    const models = providerModels[provider] || [];
    els.model.innerHTML = '<option value="">默认</option>' +
      models.map(m => `<option value="${m}" ${m === selectedModel ? 'selected' : ''}>${m}</option>`).join('');
  }

  function updateApiUrlVisibility(provider) {
    els.apiUrlGroup.style.display = provider === 'custom' ? 'block' : 'none';
  }

  els.provider.addEventListener('change', () => {
    updateModelOptions(els.provider.value, '');
    updateApiUrlVisibility(els.provider.value);
  });

  els.enabledToggle.addEventListener('click', () => {
    els.enabledToggle.classList.toggle('active');
  });

  // Test connection
  let isTesting = false;
  els.testBtn.addEventListener('click', async () => {
    if (isTesting) return; // prevent double-click
    isTesting = true;

    els.testAlert.style.display = 'none';
    const provider = els.provider.value;
    const apiKey = els.apiKey.value.trim();
    const apiUrl = els.apiUrl.value.trim();
    const model = els.model.value;

    if (!apiKey) {
      showAlert(els.testAlert, '请先填写 API Key', 'error');
      isTesting = false;
      return;
    }

    els.testBtn.textContent = '测试中...';
    els.testBtn.disabled = true;

    try {
      // Use single text for test to avoid batch parsing complexity and ensure speed
      const result = await AIProviders.translate({
        provider,
        apiKey,
        apiUrl: apiUrl || undefined,
        model: model || undefined,
        targetLang: 'zh-CN'
      }, ['Hello world'], new AbortController().signal);

      if (result && result[0]) {
        showAlert(els.testAlert, '连接成功! 翻译测试通过: ' + result[0], 'success');
      } else {
        showAlert(els.testAlert, '连接成功但未能解析翻译结果', 'error');
      }
    } catch (err) {
      showAlert(els.testAlert, '连接失败: ' + err.message, 'error');
    } finally {
      els.testBtn.textContent = '测试连接';
      els.testBtn.disabled = false;
      isTesting = false;
    }
  });

  // Save settings
  els.saveBtn.addEventListener('click', async () => {
    const newSettings = {
      enabled: els.enabledToggle.classList.contains('active'),
      provider: els.provider.value,
      apiKey: els.apiKey.value.trim(),
      apiUrl: els.apiUrl.value.trim(),
      model: els.model.value,
      targetLang: els.targetLang.value,
      position: els.position.value,
      fontSize: parseInt(els.fontSize.value) || 20
    };

    await chrome.storage.sync.set(newSettings);

    // Notify all tabs
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'updateSettings',
          settings: newSettings
        });
      } catch (e) {}
    }

    showAlert(els.saveAlert, '设置已保存', 'success');
  });

  function showAlert(el, message, type) {
    el.textContent = message;
    el.className = 'alert alert-' + type;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 5000);
  }
});
