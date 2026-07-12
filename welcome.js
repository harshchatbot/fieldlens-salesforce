(() => {
  const openBtn = document.getElementById('openSalesforceBtn');
  if (!openBtn) {
    return;
  }

  async function askBackground() {
    return chrome.runtime.sendMessage({ type: 'FIELDLENS_OPEN_SALESFORCE' });
  }

  openBtn.addEventListener('click', async (event) => {
    event.preventDefault();
    openBtn.disabled = true;
    try {
      let response = null;
      try {
        response = await askBackground();
      } catch (_) {
        // service worker can be cold-starting right after install; retry once
        await new Promise((resolve) => setTimeout(resolve, 180));
        response = await askBackground();
      }
      if (!response?.ok) {
        window.open('https://login.salesforce.com', '_blank', 'noopener');
      }
    } catch (_) {
      window.open('https://login.salesforce.com', '_blank', 'noopener');
    } finally {
      openBtn.disabled = false;
    }
  });
})();
