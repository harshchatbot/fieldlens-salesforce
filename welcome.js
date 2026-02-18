(() => {
  const openBtn = document.getElementById('openSalesforceBtn');
  if (!openBtn) {
    return;
  }

  openBtn.addEventListener('click', async (event) => {
    event.preventDefault();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'FIELDLENS_OPEN_SALESFORCE' });
      if (!response?.ok) {
        window.open('https://login.salesforce.com', '_blank', 'noopener');
      }
    } catch (_) {
      window.open('https://login.salesforce.com', '_blank', 'noopener');
    }
  });
})();
